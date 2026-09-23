'use strict';

/** Contributions, payments, receipts, payouts and reconciliation. */

const express = require('express');
const { Cycle, Contribution, PaymentAttempt, Payout, SupportTicket, Membership, Group } = require('../models');
const { h, auth, validate } = require('../middleware');
const { err } = require('../utils/errors');
const v = require('../utils/validators');
const G = require('../services/groups');
const payments = require('../services/payments');
const payoutsSvc = require('../services/payouts');
const { logActivity } = require('../services/notify');

const router = express.Router();
const { z } = v;

router.use(auth);

async function loadCycleForUser(cycleId, user) {
  if (!/^[a-f0-9]{24}$/i.test(cycleId)) throw err('NOT_FOUND', 'Cycle not found.');
  const cycle = await Cycle.findById(cycleId);
  if (!cycle) throw err('NOT_FOUND', 'Cycle not found.');
  const ctx = await G.loadGroupForUser(cycle.groupId, user);
  return { cycle, ...ctx };
}

// ------------------------------------------------------------------ Cycles

router.get(
  '/cycles/:id',
  h(async (req, res) => {
    const { cycle } = await loadCycleForUser(req.params.id, req.user);
    const roster = await G.paymentRoster(cycle);
    const payout = await Payout.findOne({ cycleId: cycle._id });
    res.json({ ...roster, outstandingMembers: roster.members.filter((m) => m.outstanding > 0), payout: payout && (await payoutsSvc.describePayout(payout)) });
  }),
);

/** Start / Unpaid / Part paid: the caller's contribution for this cycle and prior payments. */
router.get(
  '/cycles/:id/my-contribution',
  h(async (req, res) => {
    const { cycle, membership } = await loadCycleForUser(req.params.id, req.user);
    const c = membership && (await Contribution.findOne({ cycleId: cycle._id, membershipId: membership._id }));
    if (!c) return res.json({ contribution: null, cycle: G.cycleView(cycle) });
    const attempts = await PaymentAttempt.find({ contributionId: c._id, status: 'success' }).sort({ confirmedAt: 1 });
    return res.json({
      cycle: G.cycleView(cycle),
      contribution: { ...c.toJSON(), outstandingAmount: c.outstandingAmount },
      payments: attempts.map((a) => ({ reference: a.reference, kind: a.kind, amount: a.amountCredited, serviceFee: a.serviceFee, total: a.gatewayAmountReceived, paidAt: a.confirmedAt })),
      acceptingPayments: ['open', 'overdue', 'resolution_required'].includes(cycle.status),
    });
  }),
);

/** Review screen: contribution + 2% service fee = total. No side effects. */
router.get(
  '/cycles/:id/contributions/quote',
  validate(z.object({ amount: z.coerce.number().int().positive().optional() }), 'query'),
  h(async (req, res) => {
    const { contribution, group } = await payments.loadPayableContribution(req.params.id, req.user._id);
    res.json({ quote: payments.quote(contribution, req.query.amount, group.platformFeeBps) });
  }),
);

/**
 * Pay (full or partial). `amount` in kobo; omit it to pay the full outstanding balance.
 * Returns the Squadco checkout URL; the app opens it, then calls /payments/:reference/verify
 * (the webhook confirms independently).
 */
router.post(
  '/cycles/:id/contributions',
  validate(z.object({ amount: v.kobo.optional() })),
  h(async (req, res) => {
    const { attempt, quote, checkoutUrl } = await payments.initiateContributionPayment({
      cycleId: req.params.id,
      user: req.user,
      amount: req.body.amount,
    });
    res.status(201).json({ payment: attempt.toJSON(), quote, checkoutUrl, reference: attempt.reference });
  }),
);

router.get(
  '/cycles/:id/contributions',
  h(async (req, res) => {
    const { cycle } = await loadCycleForUser(req.params.id, req.user);
    res.json(await G.paymentRoster(cycle));
  }),
);

/** Resolution Required → "Contact support". Manual, human-in-the-loop only. */
router.post(
  '/cycles/:id/support',
  validate(z.object({ message: z.string().trim().min(5).max(2000) })),
  h(async (req, res) => {
    const { cycle, group } = await loadCycleForUser(req.params.id, req.user);
    const ticket = await SupportTicket.create({
      kind: 'cycle_resolution',
      userId: req.user._id,
      groupId: group._id,
      cycleId: cycle._id,
      message: req.body.message,
    });
    res.status(201).json({ ticket: ticket.toJSON() });
  }),
);

// ------------------------------------------------------------------ Payments & receipts

async function loadOwnAttempt(reference, user) {
  const attempt = await PaymentAttempt.findOne({ reference });
  if (!attempt) throw err('NOT_FOUND', 'Payment not found.');
  if (String(attempt.userId) !== String(user._id) && !user.isAdmin) {
    // The coordinator of the group may also view receipts.
    const group = await Group.findById(attempt.groupId);
    if (!group || String(group.coordinatorId) !== String(user._id)) throw err('ACCESS_DENIED');
  }
  return attempt;
}

/** Called by the app when checkout closes. Idempotent with the webhook. */
router.post(
  '/payments/:reference/verify',
  h(async (req, res) => {
    await loadOwnAttempt(req.params.reference, req.user);
    const attempt = await payments.verifyAndApply(req.params.reference);
    const contribution = await Contribution.findById(attempt.contributionId);
    res.json({
      payment: attempt.toJSON(),
      contribution: { ...contribution.toJSON(), outstandingAmount: contribution.outstandingAmount },
      result:
        attempt.status !== 'success'
          ? attempt.status
          : contribution.status === 'reconciliation_required' || contribution.status === 'under_review'
            ? 'reconciliation_required'
            : contribution.amountPaid >= contribution.amountDue
              ? 'full_payment_received'
              : 'partial_payment_received',
    });
  }),
);

router.get(
  '/payments/:reference',
  h(async (req, res) => {
    const attempt = await loadOwnAttempt(req.params.reference, req.user);
    res.json({ payment: attempt.toJSON() });
  }),
);

router.get(
  '/payments/:reference/receipt',
  h(async (req, res) => {
    const attempt = await loadOwnAttempt(req.params.reference, req.user);
    if (attempt.status !== 'success') throw err('NOT_FOUND', 'No receipt: this payment was not completed.');
    res.json({ receipt: await payments.receiptFor(attempt) });
  }),
);

/** Payment Receipts list for the current user (optionally one group). */
router.get(
  '/receipts',
  validate(z.object({ groupId: v.objectId.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), 'query'),
  h(async (req, res) => {
    const q = { userId: req.user._id, status: 'success' };
    if (req.query.groupId) q.groupId = req.query.groupId;
    const list = await PaymentAttempt.find(q).sort({ confirmedAt: -1 }).limit(req.query.limit);
    res.json({ receipts: await Promise.all(list.map((a) => payments.receiptFor(a))) });
  }),
);

// ------------------------------------------------------------------ Reconciliation (overpayment)

router.get(
  '/contributions/:id',
  h(async (req, res) => {
    const c = await Contribution.findById(req.params.id);
    if (!c) throw err('NOT_FOUND');
    await G.loadGroupForUser(c.groupId, req.user);
    res.json({ contribution: { ...c.toJSON(), outstandingAmount: c.outstandingAmount } });
  }),
);

/**
 * Reconciliation Required → Review Submitted. The original transaction is preserved; staff
 * decide on refund or credit via the admin endpoint.
 */
router.post(
  '/contributions/:id/reconcile',
  validate(z.object({ note: z.string().trim().max(1000).optional() })),
  h(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw err('NOT_FOUND');
    const c = await Contribution.findById(req.params.id);
    if (!c || String(c.userId) !== String(req.user._id)) throw err('NOT_FOUND', 'Contribution not found.');
    if (c.status === 'under_review') {
      const ticket = await SupportTicket.findOne({ contributionId: c._id, kind: 'reconciliation', status: 'open' });
      return res.json({ contribution: c.toJSON(), ticket: ticket && ticket.toJSON(), status: 'review_submitted' });
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
      userId: req.user._id,
      groupId: c.groupId,
      cycleId: c.cycleId,
      contributionId: c._id,
      paymentReference: c.lastPaymentReference,
      message: req.body.note || `Excess of ${c.excessAmount} kobo submitted for review.`,
    });
    await logActivity(c.groupId, req.user._id, 'reconciliation_submitted', `${req.user.name} submitted an overpayment for review.`);
    return res.status(201).json({ contribution: updated.toJSON(), ticket: ticket.toJSON(), status: 'review_submitted' });
  }),
);

// ------------------------------------------------------------------ Payouts

async function loadPayout(id, user, { coordinator = false } = {}) {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw err('NOT_FOUND', 'Payout not found.');
  const payout = await Payout.findById(id);
  if (!payout) throw err('NOT_FOUND', 'Payout not found.');
  await G.loadGroupForUser(payout.groupId, user, { coordinator });
  return payout;
}

router.get(
  '/payouts/:id',
  h(async (req, res) => {
    const payout = await loadPayout(req.params.id, req.user);
    res.json({ payout: await payoutsSvc.describePayout(payout) });
  }),
);

/** Payout Eligible → "Start payout" (coordinator or staff). */
router.post(
  '/payouts/:id/start',
  h(async (req, res) => {
    await loadPayout(req.params.id, req.user, { coordinator: true });
    const updated = await payoutsSvc.startPayout(req.params.id, req.user._id);
    res.json({ payout: await payoutsSvc.describePayout(updated) });
  }),
);

/** Payout Failed → report it, which opens a support ticket (retries are staff-only). */
router.post(
  '/payouts/:id/support',
  validate(z.object({ message: z.string().trim().min(5).max(2000) })),
  h(async (req, res) => {
    const payout = await loadPayout(req.params.id, req.user);
    const ticket = await SupportTicket.create({
      kind: 'payout',
      userId: req.user._id,
      groupId: payout.groupId,
      cycleId: payout.cycleId,
      payoutId: payout._id,
      message: req.body.message,
    });
    res.status(201).json({ ticket: ticket.toJSON() });
  }),
);

/** The caller's own payouts across groups ("when is my turn / did I get paid"). */
router.get(
  '/payouts',
  h(async (req, res) => {
    const memberships = await Membership.find({ userId: req.user._id, status: 'joined' });
    const list = await Payout.find({ recipientMembershipId: { $in: memberships.map((m) => m._id) } }).sort({ createdAt: -1 });
    res.json({ payouts: await Promise.all(list.map((p) => payoutsSvc.describePayout(p))) });
  }),
);

module.exports = router;
