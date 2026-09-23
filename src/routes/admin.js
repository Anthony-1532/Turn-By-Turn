'use strict';

/**
 * Staff-only endpoints for the manual, human-in-the-loop resolutions the MVP relies on:
 * stuck cycles (Resolution Required), overpayments (Reconciliation Required) and failed payouts.
 * No automatic refund / cancellation / voting logic exists by design.
 */

const express = require('express');
const { SupportTicket, Contribution, Cycle, Transaction, Group, User } = require('../models');
const { h, auth, adminOnly, validate } = require('../middleware');
const { err } = require('../utils/errors');
const v = require('../utils/validators');
const { formatNaira } = require('../utils/money');
const { nextReference } = require('../services/references');
const cycles = require('../services/cycles');
const payoutsSvc = require('../services/payouts');
const { notify, logActivity } = require('../services/notify');

const router = express.Router();
const { z } = v;

router.use(auth, adminOnly);

router.get(
  '/tickets',
  validate(z.object({ status: z.enum(['open', 'resolved']).default('open'), kind: z.string().optional() }), 'query'),
  h(async (req, res) => {
    const q = { status: req.query.status };
    if (req.query.kind) q.kind = req.query.kind;
    const list = await SupportTicket.find(q).sort({ createdAt: 1 }).limit(200).populate('userId', 'name phone email');
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
  validate(z.object({ action: z.enum(['refunded', 'credited', 'dismissed']), note: z.string().trim().max(1000).optional(), gatewayReference: z.string().max(80).optional() })),
  h(async (req, res) => {
    const c = await Contribution.findById(req.params.id);
    if (!c) throw err('NOT_FOUND');
    if (!['reconciliation_required', 'under_review'].includes(c.status)) throw err('CONFLICT', 'Nothing to reconcile.');
    const { action, note, gatewayReference } = req.body;
    const group = await Group.findById(c.groupId);
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
        relatedTransactionId: original && original._id,
        groupName: group.name,
        description: action === 'refunded' ? 'Overpayment refunded' : 'Overpayment held as credit',
        meta: { note, gatewayReference, resolvedBy: String(req.user._id) },
      });
    }
    const status = c.amountPaid >= c.amountDue ? 'paid' : c.amountPaid > 0 ? 'partial' : 'unpaid';
    const updated = await Contribution.findOneAndUpdate(
      { _id: c._id, status: c.status },
      { $set: { status } },
      { new: true },
    );
    if (!updated) throw err('CONFLICT', 'Contribution changed; reload.');
    if (original && original.status === 'under_review') {
      await Transaction.updateOne({ _id: original._id }, { $set: { status: 'success' } });
    }
    await SupportTicket.updateMany(
      { contributionId: c._id, kind: 'reconciliation', status: 'open' },
      { $set: { status: 'resolved', resolution: { action, note, resolvedBy: req.user._id, resolvedAt: new Date() } } },
    );
    await notify([c.userId], {
      type: 'reconciliation_update',
      title: 'Payment review complete',
      body:
        action === 'refunded'
          ? `${formatNaira(c.excessAmount)} has been refunded to you.`
          : action === 'credited'
            ? `${formatNaira(c.excessAmount)} is held as credit on your account.`
            : 'Your payment was reviewed; no further action is needed.',
      groupId: c.groupId,
      email: true,
    });
    res.json({ contribution: updated.toJSON(), adjustment: adjustment && adjustment.toJSON() });
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
  validate(z.object({ action: z.enum(['extend_deadline', 'release', 'note']), note: z.string().trim().max(1000), newDueDate: z.coerce.date().optional() })),
  h(async (req, res) => {
    const cycle = await Cycle.findById(req.params.id);
    if (!cycle) throw err('NOT_FOUND');
    if (!['overdue', 'resolution_required', 'open'].includes(cycle.status)) throw err('CONFLICT', `Cycle is ${cycle.status}.`);
    const { action, note, newDueDate } = req.body;
    const resolution = { resolvedBy: req.user._id, resolvedAt: new Date(), action, note };
    if (action === 'extend_deadline') {
      if (!newDueDate || newDueDate <= new Date()) throw err('VALIDATION_ERROR', 'newDueDate must be in the future.');
      await Cycle.updateOne({ _id: cycle._id }, { $set: { status: 'open', dueDate: newDueDate, resolution }, $unset: { overdueAt: 1, resolutionRequiredAt: 1 } });
      await logActivity(cycle.groupId, req.user._id, 'cycle_extended', `TurnByTurn support extended ${cycle.periodLabel} to ${newDueDate.toDateString()}.`);
    } else if (action === 'release') {
      await Cycle.updateOne({ _id: cycle._id }, { $set: { resolution } });
      await cycles.checkCycleFunded(cycle._id, { force: true, actorId: req.user._id });
      await logActivity(cycle.groupId, req.user._id, 'cycle_released', `TurnByTurn support released ${cycle.periodLabel} with ${formatNaira(cycle.confirmedReceived)} collected.`);
    } else {
      await Cycle.updateOne({ _id: cycle._id }, { $set: { resolution } });
    }
    await SupportTicket.updateMany(
      { cycleId: cycle._id, kind: 'cycle_resolution', status: 'open' },
      { $set: { status: 'resolved', resolution: { action, note, resolvedBy: req.user._id, resolvedAt: new Date() } } },
    );
    res.json({ cycle: (await Cycle.findById(cycle._id)).toJSON() });
  }),
);

/** Failed → Delayed Recovery: re-send a failed payout. */
router.post(
  '/payouts/:id/retry',
  h(async (req, res) => {
    const p = await payoutsSvc.retryPayout(req.params.id, req.user._id);
    res.json({ payout: await payoutsSvc.describePayout(p) });
  }),
);

router.post(
  '/payouts/:id/start',
  h(async (req, res) => {
    const p = await payoutsSvc.startPayout(req.params.id, req.user._id);
    res.json({ payout: await payoutsSvc.describePayout(p) });
  }),
);

router.post(
  '/tickets/:id/resolve',
  validate(z.object({ note: z.string().trim().min(2).max(1000) })),
  h(async (req, res) => {
    const t = await SupportTicket.findOneAndUpdate(
      { _id: req.params.id, status: 'open' },
      { $set: { status: 'resolved', resolution: { action: 'closed', note: req.body.note, resolvedBy: req.user._id, resolvedAt: new Date() } } },
      { new: true },
    );
    if (!t) throw err('NOT_FOUND', 'Open ticket not found.');
    res.json({ ticket: t.toJSON() });
  }),
);

router.post(
  '/users/:id/suspend',
  validate(z.object({ suspended: z.boolean() })),
  h(async (req, res) => {
    const u = await User.findByIdAndUpdate(req.params.id, { $set: { status: req.body.suspended ? 'suspended' : 'active' } }, { new: true });
    if (!u) throw err('NOT_FOUND');
    res.json({ user: u.toJSON() });
  }),
);

module.exports = router;
