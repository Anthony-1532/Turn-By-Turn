/**
 * Staff-only endpoints for the manual, human-in-the-loop resolutions the MVP relies on:
 * stuck cycles (Resolution Required), overpayments (Reconciliation Required) and failed payouts.
 * No automatic refund / cancellation / voting logic exists by design.
 */

import express from 'express';
import { SupportTicket, Contribution, Cycle, Transaction, Group, User, type ContributionStatus } from '../models';
import { h, auth, adminOnly, currentUser, param, parseBody, parseQuery } from '../middleware';
import { err } from '../utils/errors';
import * as v from '../utils/validators';
import { formatNaira } from '../utils/money';
import { nextReference } from '../services/references';
import * as cycles from '../services/cycles';
import * as payoutsSvc from '../services/payouts';
import { notify, logActivity } from '../services/notify';

const router = express.Router();
const { z } = v;

router.use(auth, adminOnly);

router.get(
  '/tickets',
  h(async (req, res) => {
    const { status, kind } = parseQuery(
      z.object({ status: z.enum(['open', 'resolved']).default('open'), kind: z.enum(['cycle_resolution', 'reconciliation', 'payout', 'general']).optional() }),
      req,
    );
    const list = await SupportTicket.find({ status, ...(kind ? { kind } : {}) })
      .sort({ createdAt: 1 })
      .limit(200)
      .populate('userId', 'name phone email');
    res.json({ tickets: list.map((t) => t.toJSON()) });
  }),
);

/**
 * Resolve an overpayment. The original contribution transaction is untouched; the decision is
 * recorded as a new ledger row (refund or adjustment).
 *   refunded  – staff refunded the excess out-of-band (gatewayReference optional)
 *   credited  – excess kept as credit (recorded; applying it to a future cycle is manual)
 *   dismissed – no excess after investigation
 */
router.post(
  '/contributions/:id/reconciliation',
  h(async (req, res) => {
    const admin = currentUser(req);
    const { action, note, gatewayReference } = parseBody(
      z.object({
        action: z.enum(['refunded', 'credited', 'dismissed']),
        note: z.string().trim().max(1000).optional(),
        gatewayReference: z.string().max(80).optional(),
      }),
      req,
    );
    const c = await Contribution.findById(param(req, 'id'));
    if (!c) throw err('NOT_FOUND');
    if (c.status !== 'reconciliation_required' && c.status !== 'under_review') throw err('CONFLICT', 'Nothing to reconcile.');
    const group = await Group.findById(c.groupId);
    if (!group) throw err('NOT_FOUND', 'Group not found.');
    const original = await Transaction.findOne({ reference: c.lastPaymentReference, type: 'contribution' });
    let adjustment = null;
    if (action !== 'dismissed' && c.excessAmount > 0 && c.userId) {
      adjustment = await Transaction.create({
        type: action === 'refunded' ? 'refund' : 'adjustment',
        direction: 'credit',
        amount: c.excessAmount,
        status: 'success',
        reference: await nextReference('ADJ'),
        userId: c.userId,
        groupId: c.groupId,
        cycleId: c.cycleId,
        contributionId: c._id,
        relatedTransactionId: original?._id,
        groupName: group.name,
        description: action === 'refunded' ? 'Overpayment refunded' : 'Overpayment held as credit',
        meta: { note, gatewayReference, resolvedBy: String(admin._id) },
      });
    }
    const status: ContributionStatus = c.amountPaid >= c.amountDue ? 'paid' : c.amountPaid > 0 ? 'partial' : 'unpaid';
    const updated = await Contribution.findOneAndUpdate({ _id: c._id, status: c.status }, { $set: { status } }, { new: true });
    if (!updated) throw err('CONFLICT', 'Contribution changed; reload.');
    if (original?.status === 'under_review') {
      await Transaction.updateOne({ _id: original._id }, { $set: { status: 'success' } });
    }
    await SupportTicket.updateMany(
      { contributionId: c._id, kind: 'reconciliation', status: 'open' },
      { $set: { status: 'resolved', resolution: { action, note, resolvedBy: admin._id, resolvedAt: new Date() } } },
    );
    const body =
      action === 'refunded'
        ? `${formatNaira(c.excessAmount)} has been refunded to you.`
        : action === 'credited'
          ? `${formatNaira(c.excessAmount)} is held as credit on your account.`
          : 'Your payment was reviewed; no further action is needed.';
    await notify([c.userId], { type: 'reconciliation_update', title: 'Payment review complete', body, groupId: c.groupId, email: true });
    res.json({ contribution: updated.toJSON(), adjustment: adjustment?.toJSON() ?? null });
  }),
);

/**
 * Resolve a stuck cycle.
 *   extend_deadline – new due date; cycle returns to open
 *   release         – mark complete with what was collected so the payout can proceed
 *   note            – record a decision without changing state
 */
router.post(
  '/cycles/:id/resolve',
  h(async (req, res) => {
    const admin = currentUser(req);
    const { action, note, newDueDate } = parseBody(
      z.object({
        action: z.enum(['extend_deadline', 'release', 'note']),
        note: z.string().trim().max(1000),
        newDueDate: z.coerce.date().optional(),
      }),
      req,
    );
    const cycle = await Cycle.findById(param(req, 'id'));
    if (!cycle) throw err('NOT_FOUND');
    if (cycle.status === 'complete') throw err('CONFLICT', `Cycle is ${cycle.status}.`);
    const resolution = { resolvedBy: admin._id, resolvedAt: new Date(), action, note };
    if (action === 'extend_deadline') {
      if (!newDueDate || newDueDate <= new Date()) throw err('VALIDATION_ERROR', 'newDueDate must be in the future.');
      await Cycle.updateOne(
        { _id: cycle._id },
        { $set: { status: 'open', dueDate: newDueDate, resolution }, $unset: { overdueAt: 1, resolutionRequiredAt: 1 } },
      );
      await logActivity(cycle.groupId, admin._id, 'cycle_extended', `TurnByTurn support extended ${cycle.periodLabel} to ${newDueDate.toDateString()}.`);
    } else if (action === 'release') {
      await Cycle.updateOne({ _id: cycle._id }, { $set: { resolution } });
      await cycles.checkCycleFunded(cycle._id, { force: true, actorId: admin._id });
      await logActivity(
        cycle.groupId,
        admin._id,
        'cycle_released',
        `TurnByTurn support released ${cycle.periodLabel} with ${formatNaira(cycle.confirmedReceived)} collected.`,
      );
    } else {
      await Cycle.updateOne({ _id: cycle._id }, { $set: { resolution } });
    }
    await SupportTicket.updateMany(
      { cycleId: cycle._id, kind: 'cycle_resolution', status: 'open' },
      { $set: { status: 'resolved', resolution: { action, note, resolvedBy: admin._id, resolvedAt: new Date() } } },
    );
    res.json({ cycle: (await Cycle.findById(cycle._id))?.toJSON() });
  }),
);

/** Failed → Delayed Recovery: re-send a failed payout. */
router.post(
  '/payouts/:id/retry',
  h(async (req, res) => {
    const p = await payoutsSvc.retryPayout(param(req, 'id'), currentUser(req)._id);
    res.json({ payout: await payoutsSvc.describePayout(p) });
  }),
);

router.post(
  '/payouts/:id/start',
  h(async (req, res) => {
    const p = await payoutsSvc.startPayout(param(req, 'id'), currentUser(req)._id);
    res.json({ payout: await payoutsSvc.describePayout(p) });
  }),
);

router.post(
  '/tickets/:id/resolve',
  h(async (req, res) => {
    const { note } = parseBody(z.object({ note: z.string().trim().min(2).max(1000) }), req);
    const t = await SupportTicket.findOneAndUpdate(
      { _id: param(req, 'id'), status: 'open' },
      { $set: { status: 'resolved', resolution: { action: 'closed', note, resolvedBy: currentUser(req)._id, resolvedAt: new Date() } } },
      { new: true },
    );
    if (!t) throw err('NOT_FOUND', 'Open ticket not found.');
    res.json({ ticket: t.toJSON() });
  }),
);

router.post(
  '/users/:id/suspend',
  h(async (req, res) => {
    const { suspended } = parseBody(z.object({ suspended: z.boolean() }), req);
    const u = await User.findByIdAndUpdate(param(req, 'id'), { $set: { status: suspended ? 'suspended' : 'active' } }, { new: true });
    if (!u) throw err('NOT_FOUND');
    res.json({ user: u.toJSON() });
  }),
);

export default router;
