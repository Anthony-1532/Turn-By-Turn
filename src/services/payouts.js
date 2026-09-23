'use strict';

const { Group, Cycle, Payout, Membership, User, Transaction, Contribution } = require('../models');
const { err } = require('../utils/errors');
const { formatNaira } = require('../utils/money');
const { nextReference } = require('./references');
const squadco = require('./squadco');
const { notify, logActivity } = require('./notify');

/**
 * Payout state machine:
 *   blocked → eligible → processing → sent | failed
 *   failed → delayed_recovery (retry in progress) → sent, or stays delayed_recovery on another failure
 */

async function beginAttempt(payoutId, fromStatuses, toStatus, actorId) {
  const payout = await Payout.findById(payoutId);
  if (!payout) throw err('NOT_FOUND', 'Payout not found.');
  if (!fromStatuses.includes(payout.status)) {
    throw err('PAYOUT_NOT_ELIGIBLE', `Payout is ${payout.status}.`, { details: { status: payout.status } });
  }
  const inFlight = payout.attempts.find((a) => a.reference === payout.reference && a.status === 'processing');
  if (inFlight) throw err('PAYOUT_NOT_ELIGIBLE', 'A transfer attempt is still in progress.');
  const recipient = payout.recipientUserId && (await User.findById(payout.recipientUserId));
  if (!recipient || !recipient.bankAccount || !recipient.bankAccount.verified) throw err('PAYOUT_ACCOUNT_MISSING');

  const reference = await nextReference('PAY');
  const claimed = await Payout.findOneAndUpdate(
    { _id: payout._id, status: payout.status },
    {
      $set: {
        status: toStatus,
        reference,
        processingAt: new Date(),
        destination: {
          bankCode: recipient.bankAccount.bankCode,
          bankName: recipient.bankAccount.bankName,
          accountNumber: recipient.bankAccount.accountNumber,
          accountName: recipient.bankAccount.accountName,
        },
      },
      $push: { attempts: { reference, status: 'processing', startedAt: new Date(), startedBy: actorId || undefined } },
    },
    { new: true },
  );
  if (!claimed) throw err('PAYOUT_NOT_ELIGIBLE', 'Payout was updated by someone else. Refresh and try again.');

  const group = await Group.findById(payout.groupId);
  const cycle = await Cycle.findById(payout.cycleId);
  await Transaction.create({
    type: 'payout',
    direction: 'credit',
    amount: claimed.confirmedAmount,
    status: 'pending',
    reference,
    userId: recipient._id,
    groupId: group._id,
    cycleId: cycle._id,
    payoutId: claimed._id,
    groupName: group.name,
    description: `${cycle.periodLabel} payout`,
  });
  return { payout: claimed, recipient, group, cycle };
}

async function sendTransfer(ctx) {
  const { payout, recipient, group, cycle } = ctx;
  const result = await squadco.transfer({
    reference: payout.reference,
    amountKobo: payout.confirmedAmount,
    bankCode: recipient.bankAccount.bankCode,
    accountNumber: recipient.bankAccount.accountNumber,
    accountName: recipient.bankAccount.accountName,
    remark: `${group.name} ${cycle.periodLabel} payout`,
  });
  return applyTransferOutcome(payout.reference, result);
}

/** Coordinator/admin (or the auto-payout job) releases an eligible payout. */
async function startPayout(payoutId, actorId) {
  const ctx = await beginAttempt(payoutId, ['eligible'], 'processing', actorId);
  await logActivity(ctx.group._id, actorId, 'payout_started', `Payout of ${formatNaira(ctx.payout.confirmedAmount)} to ${ctx.recipient.name} started.`, {
    payoutId: ctx.payout._id,
  });
  return sendTransfer(ctx);
}

/** Admin retries a failed payout; tracked as its own delayed_recovery state. */
async function retryPayout(payoutId, actorId) {
  const ctx = await beginAttempt(payoutId, ['failed', 'delayed_recovery'], 'delayed_recovery', actorId);
  await notify([ctx.recipient._id], {
    type: 'payout_delayed_recovery',
    title: 'Your payout is being retried',
    body: `We're re-sending your ${ctx.group.name} payout of ${formatNaira(ctx.payout.confirmedAmount)}. Your contribution is safe. Ref ${ctx.payout.reference}.`,
    groupId: ctx.group._id,
    data: { payoutId: String(ctx.payout._id) },
  });
  return sendTransfer(ctx);
}

/**
 * Applies a transfer outcome keyed by payout reference (from the synchronous response, a
 * webhook or a requery). Idempotent: attempts that already finished are left alone.
 */
async function applyTransferOutcome(reference, result) {
  const payout = await Payout.findOne({ 'attempts.reference': reference });
  if (!payout) return null;
  const attempt = payout.attempts.find((a) => a.reference === reference);
  if (!attempt || attempt.status !== 'processing' || result.status === 'processing') return payout;

  const now = new Date();
  if (result.status === 'sent') {
    const updated = await Payout.findOneAndUpdate(
      { _id: payout._id, attempts: { $elemMatch: { reference, status: 'processing' } } },
      {
        $set: { status: 'sent', sentAt: now, 'attempts.$[a].status': 'sent', 'attempts.$[a].finishedAt': now },
        $unset: { failureReason: 1 },
      },
      { new: true, arrayFilters: [{ 'a.reference': reference }] },
    );
    if (!updated) return Payout.findById(payout._id);
    await Transaction.updateOne({ reference, type: 'payout' }, { $set: { status: 'success' } });
    await Membership.updateOne({ _id: updated.recipientMembershipId }, { $set: { hasReceivedPayout: true } });

    const [group, cycle, recipient] = await Promise.all([
      Group.findById(updated.groupId),
      Cycle.findById(updated.cycleId),
      User.findById(updated.recipientUserId),
    ]);
    await logActivity(group._id, null, 'payout_sent', `${recipient.name} received ${formatNaira(updated.confirmedAmount)} for ${cycle.periodLabel}.`, {
      payoutId: updated._id,
      reference,
    });
    await notify([recipient._id], {
      type: 'payout_sent',
      title: 'Payout sent',
      body: `${formatNaira(updated.confirmedAmount)} from ${group.name} is on its way to ${updated.destination.bankName} ••${updated.destination.accountNumber.slice(-4)}. Ref ${reference}.`,
      groupId: group._id,
      data: { payoutId: String(updated._id), reference },
      email: true,
      sms: true,
    });
    const members = await Membership.find({ groupId: group._id, status: 'joined', userId: { $ne: recipient._id } });
    await notify(
      members.map((m) => m.userId),
      {
        type: 'payout_sent',
        title: `${group.name}: payout sent`,
        body: `${recipient.name} received the ${cycle.periodLabel} payout.`,
        groupId: group._id,
        data: { payoutId: String(updated._id) },
      },
    );
    await completeGroupIfDone(group);
    return updated;
  }

  // failed
  const nextStatus = payout.status === 'delayed_recovery' ? 'delayed_recovery' : 'failed';
  const updated = await Payout.findOneAndUpdate(
    { _id: payout._id, attempts: { $elemMatch: { reference, status: 'processing' } } },
    {
      $set: {
        status: nextStatus,
        failedAt: now,
        failureReason: result.failureReason || 'Transfer failed',
        'attempts.$[a].status': 'failed',
        'attempts.$[a].finishedAt': now,
        'attempts.$[a].failureReason': result.failureReason,
      },
    },
    { new: true, arrayFilters: [{ 'a.reference': reference }] },
  );
  if (!updated) return Payout.findById(payout._id);
  await Transaction.updateOne({ reference, type: 'payout' }, { $set: { status: 'failed', 'meta.reason': result.failureReason } });
  const group = await Group.findById(updated.groupId);
  await logActivity(group._id, null, 'payout_failed', `Payout ${reference} failed: ${updated.failureReason}. Support is on it.`, {
    payoutId: updated._id,
  });
  await notify([updated.recipientUserId, group.coordinatorId], {
    type: 'payout_failed',
    title: `${group.name}: payout delayed`,
    body: `The transfer did not go through (${updated.failureReason}). The money is safe and will be re-sent.`,
    groupId: group._id,
    data: { payoutId: String(updated._id), reference },
    email: true,
  });
  return updated;
}

async function completeGroupIfDone(group) {
  const total = group.payoutOrder.length;
  const sent = await Payout.countDocuments({ groupId: group._id, status: 'sent' });
  if (sent < total) return false;
  const res = await Group.updateOne({ _id: group._id, status: 'active' }, { $set: { status: 'completed', completedAt: new Date() } });
  if (res.modifiedCount) {
    await logActivity(group._id, null, 'group_completed', `${group.name} is complete. Every member has received a payout.`);
  }
  return true;
}

/** Job: requery transfers whose outcome is still unknown. */
async function requeryInFlight(minAgeSeconds = 120) {
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000);
  const payouts = await Payout.find({ status: { $in: ['processing', 'delayed_recovery'] }, processingAt: { $lt: cutoff } });
  let n = 0;
  for (const p of payouts) {
    const a = p.attempts.find((x) => x.reference === p.reference);
    if (!a || a.status !== 'processing') continue;
    const result = await squadco.requeryTransfer(p.reference);
    await applyTransferOutcome(p.reference, result);
    n += 1;
  }
  return n;
}

/** Job (only when AUTO_START_PAYOUTS=true): release eligible payouts automatically. */
async function autoStartEligible() {
  const eligible = await Payout.find({ status: 'eligible' }).limit(100);
  let n = 0;
  for (const p of eligible) {
    try {
      await startPayout(p._id, null);
      n += 1;
    } catch (e) {
      if (e.code !== 'PAYOUT_ACCOUNT_MISSING') console.error('[payouts] auto start failed', String(p._id), e.message);
    }
  }
  return n;
}

/** Shape used by every payout screen (Blocked / Eligible / Processing / Sent / Failed / Delayed Recovery). */
async function describePayout(payout) {
  const [cycle, recipient, group] = await Promise.all([
    Cycle.findById(payout.cycleId),
    payout.recipientUserId ? User.findById(payout.recipientUserId) : null,
    Group.findById(payout.groupId),
  ]);
  let blockingMembers = [];
  if (payout.status === 'blocked') {
    const owing = await Contribution.find({ cycleId: payout.cycleId, $expr: { $lt: ['$amountPaid', '$amountDue'] } });
    const ms = await Membership.find({ _id: { $in: owing.map((o) => o.membershipId) } }).populate('userId', 'name');
    const nameOf = new Map(ms.map((m) => [String(m._id), (m.userId && m.userId.name) || m.inviteName || m.invitePhone]));
    blockingMembers = owing.map((o) => ({
      membershipId: String(o.membershipId),
      name: nameOf.get(String(o.membershipId)),
      outstanding: o.amountDue - o.amountPaid,
    }));
  }
  const expected = cycle.expectedTotal;
  const confirmed = payout.status === 'blocked' ? cycle.confirmedReceived : payout.confirmedAmount;
  return {
    ...payout.toJSON(),
    group: { id: String(group._id), name: group.name },
    cycle: { id: String(cycle._id), number: cycle.cycleNumber, periodLabel: cycle.periodLabel, dueDate: cycle.dueDate, status: cycle.status },
    recipient: recipient ? { id: String(recipient._id), name: recipient.name, initials: recipient.initials } : null,
    expectedAmount: expected,
    confirmedAmount: confirmed,
    outstandingAmount: Math.max(0, expected - confirmed),
    blockingMembers,
  };
}

module.exports = {
  startPayout,
  retryPayout,
  applyTransferOutcome,
  requeryInFlight,
  autoStartEligible,
  completeGroupIfDone,
  describePayout,
};
