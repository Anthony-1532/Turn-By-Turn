'use strict';

const { config } = require('../config/env');
const { Group, Membership, Cycle, Contribution, Payout, SupportTicket, Reminder } = require('../models');
const { cycleDueDate, periodLabel } = require('../utils/dates');
const { formatNaira } = require('../utils/money');
const { notify, logActivity } = require('./notify');

const ACCEPTING_PAYMENTS = ['open', 'overdue', 'resolution_required'];

async function participantMemberships(group) {
  const ms = await Membership.find({ _id: { $in: group.payoutOrder } });
  const byId = new Map(ms.map((m) => [String(m._id), m]));
  return group.payoutOrder.map((id) => byId.get(String(id))).filter(Boolean);
}

/**
 * Opens cycle `n` for an active group: creates the Cycle, one Contribution per participant and
 * a blocked Payout for this turn's recipient. Idempotent on (groupId, cycleNumber).
 */
async function openCycle(group, n) {
  const existing = await Cycle.findOne({ groupId: group._id, cycleNumber: n });
  if (existing) return existing;

  const members = await participantMemberships(group);
  const recipient = members[n - 1];
  if (!recipient) throw new Error(`No recipient at position ${n} for group ${group._id}`);

  const dueDate = cycleDueDate(group.firstDueDate, group.cycleFrequency, n);
  let cycle;
  try {
    cycle = await Cycle.create({
      groupId: group._id,
      cycleNumber: n,
      periodLabel: periodLabel(dueDate, group.cycleFrequency, n),
      dueDate,
      expectedTotal: group.contributionAmount * members.length,
      recipientMembershipId: recipient._id,
      recipientUserId: recipient.userId,
    });
  } catch (e) {
    if (e.code === 11000) return Cycle.findOne({ groupId: group._id, cycleNumber: n });
    throw e;
  }

  await Contribution.insertMany(
    members.map((m) => ({
      cycleId: cycle._id,
      groupId: group._id,
      membershipId: m._id,
      userId: m.userId,
      amountDue: group.contributionAmount,
    })),
  );
  await Payout.create({
    cycleId: cycle._id,
    groupId: group._id,
    recipientMembershipId: recipient._id,
    recipientUserId: recipient.userId,
    status: 'blocked',
    expectedAmount: cycle.expectedTotal,
  });
  await Group.updateOne({ _id: group._id, currentCycleNumber: { $lt: n } }, { $set: { currentCycleNumber: n } });

  await logActivity(group._id, null, 'cycle_opened', `${cycle.periodLabel} opened. ${formatNaira(group.contributionAmount)} due ${dueDate.toDateString()}.`, {
    cycleId: cycle._id,
    cycleNumber: n,
  });
  await notify(
    members.map((m) => m.userId),
    {
      type: 'cycle_opened',
      title: `${group.name}: ${cycle.periodLabel} is open`,
      body: `${formatNaira(group.contributionAmount)} is due by ${dueDate.toDateString()}.`,
      groupId: group._id,
      data: { cycleId: String(cycle._id) },
    },
  );
  return cycle;
}

/**
 * Called after money is credited to a cycle (or an admin unblocks it). When the cycle is fully
 * funded it is marked complete, its payout becomes eligible, and the next cycle opens.
 */
async function checkCycleFunded(cycleId, { force = false, actorId } = {}) {
  const cycle = await Cycle.findById(cycleId);
  if (!cycle || cycle.status === 'complete') return cycle;
  if (!force && cycle.confirmedReceived < cycle.expectedTotal) return cycle;

  const updated = await Cycle.findOneAndUpdate(
    { _id: cycle._id, status: { $ne: 'complete' } },
    { $set: { status: 'complete', completedAt: new Date() } },
    { new: true },
  );
  if (!updated) return Cycle.findById(cycleId); // someone else completed it

  const payout = await Payout.findOneAndUpdate(
    { cycleId: cycle._id, status: 'blocked' },
    { $set: { status: 'eligible', eligibleAt: new Date(), confirmedAmount: updated.confirmedReceived } },
    { new: true },
  );
  const group = await Group.findById(cycle.groupId);

  await logActivity(group._id, actorId, 'cycle_complete', `${updated.periodLabel} is fully funded. Payout is ready.`, {
    cycleId: cycle._id,
  });
  await notify([group.coordinatorId, updated.recipientUserId], {
    type: 'payout_eligible',
    title: `${group.name}: payout ready`,
    body: `${updated.periodLabel} collected ${formatNaira(updated.confirmedReceived)}. The payout can now be released.`,
    groupId: group._id,
    data: { cycleId: String(cycle._id), payoutId: payout && String(payout._id) },
  });

  if (updated.cycleNumber < group.payoutOrder.length) {
    await openCycle(group, updated.cycleNumber + 1);
  }

  if (payout && config.payouts.autoStart) {
    const payouts = require('./payouts');
    await payouts.startPayout(payout._id, null).catch((e) => console.error('[cycles] auto payout failed:', e.message));
  }
  return updated;
}

/** Recomputes cycle.confirmedReceived from contributions (used by admin tooling & tests). */
async function recomputeCycleTotals(cycleId) {
  const [agg] = await Contribution.aggregate([
    { $match: { cycleId } },
    { $group: { _id: null, paid: { $sum: '$amountPaid' } } },
  ]);
  await Cycle.updateOne({ _id: cycleId }, { $set: { confirmedReceived: (agg && agg.paid) || 0 } });
}

async function outstandingContributions(cycleId) {
  return Contribution.find({ cycleId, $expr: { $lt: ['$amountPaid', '$amountDue'] } });
}

// ------------------------------------------------------------------------- Scheduled work

/** open → overdue once the due date plus the grace period has passed. */
async function markOverdueCycles(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.cycles.overdueGraceHours * 3600000);
  const cycles = await Cycle.find({ status: 'open', dueDate: { $lt: cutoff } });
  let count = 0;
  for (const c of cycles) {
    const updated = await Cycle.findOneAndUpdate(
      { _id: c._id, status: 'open' },
      { $set: { status: 'overdue', overdueAt: now } },
      { new: true },
    );
    if (!updated) continue;
    count += 1;
    const group = await Group.findById(c.groupId);
    const outstanding = await outstandingContributions(c._id);
    await logActivity(group._id, null, 'cycle_overdue', `${c.periodLabel} is overdue. ${outstanding.length} member(s) still owe.`, {
      cycleId: c._id,
    });
    await notify(
      outstanding.map((o) => o.userId),
      {
        type: 'cycle_overdue',
        title: `${group.name}: payment overdue`,
        body: `Your ${c.periodLabel} contribution is overdue. The payout is on hold until everyone pays.`,
        groupId: group._id,
        data: { cycleId: String(c._id) },
        email: true,
        sms: true,
      },
    );
    await notify([group.coordinatorId], {
      type: 'cycle_overdue',
      title: `${group.name}: ${c.periodLabel} overdue`,
      body: `${outstanding.length} member(s) have not paid in full. The payout is blocked.`,
      groupId: group._id,
      data: { cycleId: String(c._id) },
    });
  }
  return count;
}

/**
 * overdue → resolution_required after CYCLE_RESOLUTION_AFTER_DAYS. MVP has no automatic
 * cancellation, replacement, refund, voting or payout rule: we open a support ticket and stop.
 */
async function escalateStuckCycles(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.cycles.resolutionAfterDays * 86400000);
  const cycles = await Cycle.find({ status: 'overdue', overdueAt: { $lt: cutoff } });
  let count = 0;
  for (const c of cycles) {
    const updated = await Cycle.findOneAndUpdate(
      { _id: c._id, status: 'overdue' },
      { $set: { status: 'resolution_required', resolutionRequiredAt: now } },
      { new: true },
    );
    if (!updated) continue;
    count += 1;
    const group = await Group.findById(c.groupId);
    await SupportTicket.create({
      kind: 'cycle_resolution',
      userId: group.coordinatorId,
      groupId: group._id,
      cycleId: c._id,
      message: `System: ${c.periodLabel} has been overdue since ${c.overdueAt.toISOString()} and needs manual resolution.`,
    });
    await logActivity(group._id, null, 'cycle_resolution_required', `${c.periodLabel} needs resolution. TurnByTurn support has been alerted.`, {
      cycleId: c._id,
    });
    const members = await Membership.find({ groupId: group._id, status: 'joined' });
    await notify(
      members.map((m) => m.userId),
      {
        type: 'cycle_resolution_required',
        title: `${group.name}: resolution required`,
        body: `${c.periodLabel} is still incomplete. Contact support if you need help; your confirmed payments are safe.`,
        groupId: group._id,
        data: { cycleId: String(c._id) },
        email: true,
      },
    );
  }
  return count;
}

/** Scheduled reminders N days before the due date to members who haven't paid in full. */
async function sendScheduledReminders(now = new Date()) {
  const days = config.cycles.autoReminderDaysBefore;
  if (!days.length) return 0;
  const maxDays = Math.max(...days);
  const cycles = await Cycle.find({
    status: 'open',
    dueDate: { $gt: now, $lte: new Date(now.getTime() + maxDays * 86400000) },
  });
  let sent = 0;
  for (const c of cycles) {
    const outstanding = await outstandingContributions(c._id);
    if (!outstanding.length) continue;
    // Every threshold already crossed gets a marker, but members get at most one nudge per run.
    const applicable = days.filter((d) => c.dueDate.getTime() <= now.getTime() + d * 86400000);
    let isNew = false;
    for (const d of applicable) {
      try {
        await Reminder.create({
          groupId: c.groupId,
          cycleId: c._id,
          kind: 'auto',
          autoKey: `d${d}`,
          channels: ['push', 'in_app'],
          targetMembershipIds: outstanding.map((o) => o.membershipId),
        });
        isNew = true;
      } catch (e) {
        if (e.code !== 11000) throw e; // 11000: this threshold was already handled
      }
    }
    if (!isNew) continue;
    const group = await Group.findById(c.groupId);
    await notify(
      outstanding.map((o) => o.userId),
      {
        type: 'payment_reminder',
        title: `${group.name}: payment due soon`,
        body: `Your ${c.periodLabel} contribution is due ${c.dueDate.toDateString()}.`,
        groupId: group._id,
        data: { cycleId: String(c._id) },
      },
    );
    sent += 1;
  }
  return sent;
}

module.exports = {
  ACCEPTING_PAYMENTS,
  participantMemberships,
  openCycle,
  checkCycleFunded,
  recomputeCycleTotals,
  outstandingContributions,
  markOverdueCycles,
  escalateStuckCycles,
  sendScheduledReminders,
};
