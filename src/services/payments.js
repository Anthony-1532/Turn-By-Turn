'use strict';

const { config } = require('../config/env');
const { Group, Cycle, Contribution, PaymentAttempt, Transaction, Membership, User } = require('../models');
const { err } = require('../utils/errors');
const { breakdown, formatNaira } = require('../utils/money');
const { nextReference } = require('./references');
const squadco = require('./squadco');
const cycles = require('./cycles');
const { notify, logActivity } = require('./notify');

/**
 * Validates an amount against what's still owed and returns the Review-screen breakdown.
 * `amount` omitted means "pay everything outstanding".
 */
function quote(contribution, amount, feeBps) {
  const outstanding = Math.max(0, contribution.amountDue - contribution.amountPaid);
  if (outstanding === 0) throw err('NOTHING_DUE');
  const amt = amount == null ? outstanding : amount;
  if (!Number.isSafeInteger(amt) || amt <= 0) throw err('AMOUNT_INVALID');
  if (amt > outstanding) {
    throw err('AMOUNT_INVALID', `You can pay at most ${formatNaira(outstanding)} for this cycle.`, {
      details: { outstanding },
    });
  }
  if (amt < outstanding && amt < config.money.minPartialPaymentKobo) {
    throw err('AMOUNT_INVALID', `The minimum part payment is ${formatNaira(config.money.minPartialPaymentKobo)}.`, {
      details: { minimum: config.money.minPartialPaymentKobo },
    });
  }
  return {
    kind: amt === outstanding ? 'full' : 'partial',
    ...breakdown(amt, feeBps),
    amountDue: contribution.amountDue,
    alreadyPaid: contribution.amountPaid,
    outstandingBefore: outstanding,
    remainingAfter: outstanding - amt,
  };
}

async function loadPayableContribution(cycleId, userId) {
  const cycle = await Cycle.findById(cycleId);
  if (!cycle) throw err('NOT_FOUND', 'Cycle not found.');
  const membership = await Membership.findOne({ groupId: cycle.groupId, userId, status: 'joined' });
  if (!membership) throw err('ACCESS_DENIED');
  const contribution = await Contribution.findOne({ cycleId: cycle._id, membershipId: membership._id });
  if (!contribution) throw err('NOTHING_DUE', 'You do not contribute to this group.');
  const group = await Group.findById(cycle.groupId);
  return { cycle, membership, contribution, group };
}

/** Creates a PaymentAttempt and a Squadco checkout for a full or partial payment. */
async function initiateContributionPayment({ cycleId, user, amount }) {
  const { cycle, contribution, group } = await loadPayableContribution(cycleId, user._id);
  if (!cycles.ACCEPTING_PAYMENTS.includes(cycle.status)) throw err('CYCLE_CLOSED');
  const q = quote(contribution, amount, group.platformFeeBps);

  const reference = await nextReference('TRX');
  const attempt = await PaymentAttempt.create({
    reference,
    contributionId: contribution._id,
    cycleId: cycle._id,
    groupId: group._id,
    userId: user._id,
    kind: q.kind,
    amount: q.contribution,
    serviceFee: q.serviceFee,
    totalCharged: q.total,
  });
  const checkout = await squadco.initiatePayment({
    reference,
    amountKobo: q.total,
    email: user.email,
    customerName: user.name,
    metadata: { groupId: String(group._id), cycleId: String(cycle._id), contributionId: String(contribution._id) },
  });
  attempt.checkoutUrl = checkout.checkoutUrl;
  attempt.gatewayReference = checkout.gatewayReference;
  await attempt.save();
  return { attempt, quote: q, checkoutUrl: checkout.checkoutUrl };
}

/** Principal p such that p + fee(p) <= received, for payments that arrive short. */
function principalFromTotal(received, bps) {
  return Math.floor((received * 10000) / (10000 + bps));
}

/**
 * Applies a gateway outcome to a payment attempt. Safe to call any number of times for the same
 * reference (webhook retries, the app's verify call, the reconciliation job): only the first
 * caller to claim the pending attempt credits money.
 *
 * @param {string} reference
 * @param {{status:'success'|'failed'|'pending', amountKobo?:number|null, channel?:string, reason?:string}} outcome
 */
async function applyPaymentOutcome(reference, outcome) {
  if (outcome.status === 'pending') return PaymentAttempt.findOne({ reference });

  const attempt = await PaymentAttempt.findOneAndUpdate(
    { reference, status: 'pending' },
    { $set: { status: 'processing' } },
    { new: true },
  );
  if (!attempt) return PaymentAttempt.findOne({ reference }); // already handled (or unknown)

  const group = await Group.findById(attempt.groupId);
  const user = await User.findById(attempt.userId);

  if (outcome.status === 'failed') {
    attempt.status = 'failed';
    attempt.failureReason = outcome.reason || 'Payment was not completed';
    await attempt.save();
    await Transaction.create({
      type: 'contribution',
      direction: 'debit',
      amount: attempt.amount,
      status: 'failed',
      reference,
      userId: attempt.userId,
      groupId: attempt.groupId,
      cycleId: attempt.cycleId,
      contributionId: attempt.contributionId,
      paymentAttemptId: attempt._id,
      groupName: group.name,
      description: `Contribution payment failed`,
      meta: { reason: attempt.failureReason },
    });
    return attempt;
  }

  // ---- success
  const bps = group.platformFeeBps;
  const received = outcome.amountKobo == null ? attempt.totalCharged : outcome.amountKobo;
  let principal;
  let fee;
  let gatewayExcess = 0;
  if (received >= attempt.totalCharged) {
    principal = attempt.amount;
    fee = attempt.serviceFee;
    gatewayExcess = received - attempt.totalCharged;
  } else {
    principal = principalFromTotal(received, bps);
    fee = received - principal;
  }

  // Credit the contribution with optimistic concurrency so concurrent payments can't overshoot.
  let contribution;
  let credited = 0;
  let overshoot = 0;
  for (let i = 0; i < 10; i += 1) {
    const current = await Contribution.findById(attempt.contributionId);
    const outstanding = Math.max(0, current.amountDue - current.amountPaid);
    credited = Math.min(principal, outstanding);
    overshoot = principal - credited;
    const excess = gatewayExcess + overshoot;
    const newPaid = current.amountPaid + credited;
    const inReview = ['reconciliation_required', 'under_review'].includes(current.status);
    let status;
    if (excess > 0) status = 'reconciliation_required';
    else if (inReview) status = current.status;
    else status = newPaid >= current.amountDue ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid';

    const set = { status, lastPaymentReference: reference };
    if (!current.paidAt && credited > 0) set.paidAt = new Date();
    if (newPaid >= current.amountDue && !current.confirmedAt) set.confirmedAt = new Date();
    contribution = await Contribution.findOneAndUpdate(
      { _id: current._id, amountPaid: current.amountPaid, excessAmount: current.excessAmount },
      {
        $set: set,
        $inc: { amountPaid: credited, serviceFeePaid: fee, totalCharged: received, excessAmount: excess },
      },
      { new: true },
    );
    if (contribution) break;
  }
  if (!contribution) throw new Error(`Could not credit contribution for ${reference} after retries`);

  const excessTotal = gatewayExcess + overshoot;
  attempt.status = 'success';
  attempt.gatewayAmountReceived = received;
  attempt.amountCredited = credited;
  attempt.excessAmount = excessTotal;
  attempt.channel = outcome.channel;
  attempt.confirmedAt = new Date();
  await attempt.save();

  const cycle = await Cycle.findOneAndUpdate({ _id: attempt.cycleId }, { $inc: { confirmedReceived: credited } }, { new: true });

  const common = {
    reference,
    userId: attempt.userId,
    groupId: attempt.groupId,
    cycleId: attempt.cycleId,
    contributionId: attempt.contributionId,
    paymentAttemptId: attempt._id,
    groupName: group.name,
  };
  // The original record keeps exactly what the gateway confirmed; any excess is flagged, not altered.
  const contributionTx = await Transaction.create({
    ...common,
    type: 'contribution',
    direction: 'debit',
    amount: credited + excessTotal,
    status: excessTotal > 0 ? 'under_review' : 'success',
    description: `${cycle.periodLabel} contribution${attempt.kind === 'partial' ? ' (part payment)' : ''}`,
    meta: {
      kind: attempt.kind,
      requested: attempt.amount,
      credited,
      excess: excessTotal,
      gatewayAmountReceived: received,
      channel: outcome.channel,
    },
  });
  await Transaction.create({
    ...common,
    type: 'fee',
    direction: 'debit',
    amount: fee,
    status: 'success',
    description: `TurnByTurn service fee (${bps / 100}%)`,
    relatedTransactionId: contributionTx._id,
  });

  const fullyPaid = contribution.amountPaid >= contribution.amountDue;
  await logActivity(
    group._id,
    attempt.userId,
    fullyPaid ? 'payment_full' : 'payment_partial',
    `${user.name} paid ${formatNaira(credited)} towards ${cycle.periodLabel}${fullyPaid ? ' (fully paid)' : ''}.`,
    { cycleId: cycle._id, reference },
  );
  await notify([attempt.userId], {
    type: fullyPaid ? 'payment_received' : 'partial_payment_received',
    title: fullyPaid ? 'Payment received' : 'Part payment received',
    body: fullyPaid
      ? `We confirmed ${formatNaira(credited)} for ${group.name} (${cycle.periodLabel}). Ref ${reference}.`
      : `We confirmed ${formatNaira(credited)} for ${group.name}. ${formatNaira(contribution.amountDue - contribution.amountPaid)} is left before ${cycle.dueDate.toDateString()}.`,
    groupId: group._id,
    data: { reference, contributionId: String(contribution._id) },
    email: true,
  });
  if (excessTotal > 0) {
    await notify([attempt.userId], {
      type: 'reconciliation_update',
      title: 'Payment needs review',
      body: `We received ${formatNaira(excessTotal)} more than required for ${cycle.periodLabel}. Submit it for review and support will refund or credit it.`,
      groupId: group._id,
      data: { reference, contributionId: String(contribution._id) },
    });
  }

  if (cycle.confirmedReceived >= cycle.expectedTotal) await cycles.checkCycleFunded(cycle._id);
  return attempt;
}

/** Called by the app after checkout closes and by the stale-attempt job. */
async function verifyAndApply(reference) {
  const attempt = await PaymentAttempt.findOne({ reference });
  if (!attempt) throw err('NOT_FOUND', 'Payment not found.');
  if (attempt.status !== 'pending') return attempt;
  const outcome = await squadco.verifyPayment(reference);
  return applyPaymentOutcome(reference, outcome);
}

/** Pending checkouts older than `hours` are verified with the gateway, then abandoned. */
async function settleStaleAttempts(hours = 24) {
  const cutoff = new Date(Date.now() - hours * 3600000);
  const stale = await PaymentAttempt.find({ status: 'pending', createdAt: { $lt: cutoff } }).limit(200);
  let n = 0;
  for (const a of stale) {
    let outcome = { status: 'pending' };
    if (!config.squadco.mock) outcome = await squadco.verifyPayment(a.reference).catch(() => ({ status: 'pending' }));
    if (outcome.status === 'pending') {
      await PaymentAttempt.updateOne({ _id: a._id, status: 'pending' }, { $set: { status: 'abandoned' } });
    } else {
      await applyPaymentOutcome(a.reference, outcome);
    }
    n += 1;
  }
  return n;
}

/** Structured receipt consumed by the Payment Receipt screen. */
async function receiptFor(attempt) {
  const [group, cycle, user, contribution] = await Promise.all([
    Group.findById(attempt.groupId),
    Cycle.findById(attempt.cycleId),
    User.findById(attempt.userId),
    Contribution.findById(attempt.contributionId),
  ]);
  return {
    reference: attempt.reference,
    status: attempt.status,
    kind: attempt.kind,
    paidAt: attempt.confirmedAt,
    payer: { id: String(user._id), name: user.name, phone: user.phone },
    group: { id: String(group._id), name: group.name },
    cycle: { id: String(cycle._id), number: cycle.cycleNumber, periodLabel: cycle.periodLabel, dueDate: cycle.dueDate },
    contribution: attempt.amount,
    serviceFee: attempt.serviceFee,
    total: attempt.totalCharged,
    amountReceived: attempt.gatewayAmountReceived,
    amountCredited: attempt.amountCredited,
    excessAmount: attempt.excessAmount,
    channel: attempt.channel,
    cycleBalance: contribution
      ? { amountDue: contribution.amountDue, amountPaid: contribution.amountPaid, outstanding: contribution.outstandingAmount }
      : null,
    currency: 'NGN',
    paymentProvider: 'Squadco',
  };
}

module.exports = {
  quote,
  loadPayableContribution,
  initiateContributionPayment,
  applyPaymentOutcome,
  verifyAndApply,
  settleStaleAttempts,
  receiptFor,
  principalFromTotal,
};
