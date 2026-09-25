/** Contributions, payments, receipts, payouts and reconciliation. */

import express from 'express';
import { Cycle, Contribution, PaymentAttempt, Payout, SupportTicket, Membership, Group, type UserDoc } from '../models';
import { h, auth, currentUser, param, parseBody, parseQuery } from '../middleware';
import { err } from '../utils/errors';
import * as v from '../utils/validators';
import * as G from '../services/groups';
import * as payments from '../services/payments';
import * as payoutsSvc from '../services/payouts';
import { ACCEPTING_PAYMENTS } from '../services/cycles';
import { logActivity } from '../services/notify';

const router = express.Router();
const { z } = v;

router.use(auth);

async function loadCycleForUser(cycleId: string, user: UserDoc) {
  if (!v.isObjectId(cycleId)) throw err('NOT_FOUND', 'Cycle not found.');
  const cycle = await Cycle.findById(cycleId);
  if (!cycle) throw err('NOT_FOUND', 'Cycle not found.');
  const access = await G.loadGroupForUser(cycle.groupId, user);
  return { cycle, ...access };
}

// ------------------------------------------------------------------ Cycles

router.get(
  '/cycles/:id',
  h(async (req, res) => {
    const { cycle } = await loadCycleForUser(param(req, 'id'), currentUser(req));
    const roster = await G.paymentRoster(cycle);
    const payout = await Payout.findOne({ cycleId: cycle._id });
    res.json({
      ...roster,
      outstandingMembers: roster.members.filter((m) => m.outstanding > 0),
      payout: payout ? await payoutsSvc.describePayout(payout) : null,
    });
  }),
);

/** Start / Unpaid / Part paid: the caller's contribution for this cycle and prior payments. */
router.get(
  '/cycles/:id/my-contribution',
  h(async (req, res) => {
    const { cycle, membership } = await loadCycleForUser(param(req, 'id'), currentUser(req));
    const c = membership ? await Contribution.findOne({ cycleId: cycle._id, membershipId: membership._id }) : null;
    if (!c) return res.json({ contribution: null, cycle: G.cycleView(cycle) });
    const attempts = await PaymentAttempt.find({ contributionId: c._id, status: 'success' }).sort({ confirmedAt: 1 });
    return res.json({
      cycle: G.cycleView(cycle),
      contribution: { ...c.toJSON(), outstandingAmount: c.outstandingAmount },
      payments: attempts.map((a) => ({
        reference: a.reference,
        kind: a.kind,
        amount: a.amountCredited,
        serviceFee: a.serviceFee,
        total: a.gatewayAmountReceived,
        paidAt: a.confirmedAt,
      })),
      acceptingPayments: ACCEPTING_PAYMENTS.includes(cycle.status),
    });
  }),
);

/** Review screen: contribution + 2% service fee = total. No side effects. */
router.get(
  '/cycles/:id/contributions/quote',
  h(async (req, res) => {
    const { amount } = parseQuery(z.object({ amount: z.coerce.number().int().positive().optional() }), req);
    const { contribution, group } = await payments.loadPayableContribution(param(req, 'id'), currentUser(req)._id);
    res.json({ quote: payments.quote(contribution, amount, group.platformFeeBps) });
  }),
);

/**
 * Pay (full or partial). `amount` in kobo; omit it to pay the full outstanding balance.
 * Returns the Squadco checkout URL; the app opens it, then calls /payments/:reference/verify
 * (the webhook confirms independently).
 */
router.post(
  '/cycles/:id/contributions',
  h(async (req, res) => {
    const { amount } = parseBody(z.object({ amount: v.kobo.optional() }), req);
    const { attempt, quote, checkoutUrl } = await payments.initiateContributionPayment({
      cycleId: param(req, 'id'),
      user: currentUser(req),
      amount,
    });
    res.status(201).json({ payment: attempt.toJSON(), quote, checkoutUrl, reference: attempt.reference });
  }),
);

router.get(
  '/cycles/:id/contributions',
  h(async (req, res) => {
    const { cycle } = await loadCycleForUser(param(req, 'id'), currentUser(req));
    res.json(await G.paymentRoster(cycle));
  }),
);

/** Resolution Required → "Contact support". Manual, human-in-the-loop only. */
router.post(
  '/cycles/:id/support',
  h(async (req, res) => {
    const user = currentUser(req);
    const { message } = parseBody(z.object({ message: z.string().trim().min(5).max(2000) }), req);
    const { cycle, group } = await loadCycleForUser(param(req, 'id'), user);
    const ticket = await SupportTicket.create({ kind: 'cycle_resolution', userId: user._id, groupId: group._id, cycleId: cycle._id, message });
    res.status(201).json({ ticket: ticket.toJSON() });
  }),
);

// ------------------------------------------------------------------ Payments & receipts

async function loadOwnAttempt(reference: string, user: UserDoc) {
  const attempt = await PaymentAttempt.findOne({ reference });
  if (!attempt) throw err('NOT_FOUND', 'Payment not found.');
  if (String(attempt.userId) !== String(user._id) && !user.isAdmin) {
    // The coordinator of the group may also view receipts.
    const group = await Group.findById(attempt.groupId);
    if (!group || String(group.coordinatorId) !== String(user._id)) throw err('ACCESS_DENIED');
  }
  return attempt;
}

export type PaymentResult =
  | 'full_payment_received'
  | 'partial_payment_received'
  | 'reconciliation_required'
  | 'pending'
  | 'processing'
  | 'failed'
  | 'abandoned';

/** Called by the app when checkout closes. Idempotent with the webhook. */
router.post(
  '/payments/:reference/verify',
  h(async (req, res) => {
    const reference = param(req, 'reference');
    await loadOwnAttempt(reference, currentUser(req));
    const attempt = await payments.verifyAndApply(reference);
    const contribution = await Contribution.findById(attempt.contributionId);
    if (!contribution) throw err('NOT_FOUND', 'Contribution not found.');
    let result: PaymentResult;
    if (attempt.status !== 'success') result = attempt.status;
    else if (contribution.status === 'reconciliation_required' || contribution.status === 'under_review') result = 'reconciliation_required';
    else result = contribution.amountPaid >= contribution.amountDue ? 'full_payment_received' : 'partial_payment_received';
    res.json({
      payment: attempt.toJSON(),
      contribution: { ...contribution.toJSON(), outstandingAmount: contribution.outstandingAmount },
      result,
    });
  }),
);

router.get(
  '/payments/:reference',
  h(async (req, res) => {
    const attempt = await loadOwnAttempt(param(req, 'reference'), currentUser(req));
    res.json({ payment: attempt.toJSON() });
  }),
);

router.get(
  '/payments/:reference/receipt',
  h(async (req, res) => {
    const attempt = await loadOwnAttempt(param(req, 'reference'), currentUser(req));
    if (attempt.status !== 'success') throw err('NOT_FOUND', 'No receipt: this payment was not completed.');
    res.json({ receipt: await payments.receiptFor(attempt) });
  }),
);

/** Payment Receipts list for the current user (optionally one group). */
router.get(
  '/receipts',
  h(async (req, res) => {
    const { groupId, limit } = parseQuery(
      z.object({ groupId: v.objectId.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      req,
    );
    const list = await PaymentAttempt.find({ userId: currentUser(req)._id, status: 'success', ...(groupId ? { groupId } : {}) })
      .sort({ confirmedAt: -1 })
      .limit(limit);
    res.json({ receipts: await Promise.all(list.map((a) => payments.receiptFor(a))) });
  }),
);

// ------------------------------------------------------------------ Reconciliation (overpayment)

router.get(
  '/contributions/:id',
  h(async (req, res) => {
    const id = param(req, 'id');
    if (!v.isObjectId(id)) throw err('NOT_FOUND');
    const c = await Contribution.findById(id);
    if (!c) throw err('NOT_FOUND');
    await G.loadGroupForUser(c.groupId, currentUser(req));
    res.json({ contribution: { ...c.toJSON(), outstandingAmount: c.outstandingAmount } });
  }),
);

/**
 * Reconciliation Required → Review Submitted. The original transaction is preserved; staff
 * decide on refund or credit via the admin endpoint.
 */
router.post(
  '/contributions/:id/reconcile',
  h(async (req, res) => {
    const user = currentUser(req);
    const { note } = parseBody(z.object({ note: z.string().trim().max(1000).optional() }), req);
    const id = param(req, 'id');
    if (!v.isObjectId(id)) throw err('NOT_FOUND');
    const c = await Contribution.findById(id);
    if (!c || String(c.userId) !== String(user._id)) throw err('NOT_FOUND', 'Contribution not found.');
    if (c.status === 'under_review') {
      const ticket = await SupportTicket.findOne({ contributionId: c._id, kind: 'reconciliation', status: 'open' });
      return res.json({ contribution: c.toJSON(), ticket: ticket?.toJSON() ?? null, status: 'review_submitted' });
    }
    if (c.status !== 'reconciliation_required') throw err('CONFLICT', 'This payment does not need review.');
    const updated = await Contribution.findOneAndUpdate(
      { _id: c._id, status: 'reconciliation_required' },
      { $set: { status: 'under_review' } },
      { new: true },
    );
    if (!updated) throw err('CONFLICT', 'This payment was just updated. Refresh and try again.');
    const ticket = await SupportTicket.create({
      kind: 'reconciliation',
      userId: user._id,
      groupId: c.groupId,
      cycleId: c.cycleId,
      contributionId: c._id,
      paymentReference: c.lastPaymentReference,
      message: note || `Excess of ${c.excessAmount} kobo submitted for review.`,
    });
    await logActivity(c.groupId, user._id, 'reconciliation_submitted', `${user.name} submitted an overpayment for review.`);
    return res.status(201).json({ contribution: updated.toJSON(), ticket: ticket.toJSON(), status: 'review_submitted' });
  }),
);

// ------------------------------------------------------------------ Payouts

async function loadPayout(id: string, user: UserDoc, { coordinator = false } = {}) {
  if (!v.isObjectId(id)) throw err('NOT_FOUND', 'Payout not found.');
  const payout = await Payout.findById(id);
  if (!payout) throw err('NOT_FOUND', 'Payout not found.');
  await G.loadGroupForUser(payout.groupId, user, { coordinator });
  return payout;
}

router.get(
  '/payouts/:id',
  h(async (req, res) => {
    const payout = await loadPayout(param(req, 'id'), currentUser(req));
    res.json({ payout: await payoutsSvc.describePayout(payout) });
  }),
);

/** Payout Eligible → "Start payout" (coordinator or staff). */
router.post(
  '/payouts/:id/start',
  h(async (req, res) => {
    const user = currentUser(req);
    const payout = await loadPayout(param(req, 'id'), user, { coordinator: true });
    const updated = await payoutsSvc.startPayout(payout._id, user._id);
    res.json({ payout: await payoutsSvc.describePayout(updated) });
  }),
);

/** Payout Failed → report it, which opens a support ticket (retries are staff-only). */
router.post(
  '/payouts/:id/support',
  h(async (req, res) => {
    const user = currentUser(req);
    const { message } = parseBody(z.object({ message: z.string().trim().min(5).max(2000) }), req);
    const payout = await loadPayout(param(req, 'id'), user);
    const ticket = await SupportTicket.create({
      kind: 'payout',
      userId: user._id,
      groupId: payout.groupId,
      cycleId: payout.cycleId,
      payoutId: payout._id,
      message,
    });
    res.status(201).json({ ticket: ticket.toJSON() });
  }),
);

/** The caller's own payouts across groups ("when is my turn / did I get paid"). */
router.get(
  '/payouts',
  h(async (req, res) => {
    const memberships = await Membership.find({ userId: currentUser(req)._id, status: 'joined' });
    const list = await Payout.find({ recipientMembershipId: { $in: memberships.map((m) => m._id) } }).sort({ createdAt: -1 });
    res.json({ payouts: await Promise.all(list.map((p) => payoutsSvc.describePayout(p))) });
  }),
);

export default router;
