'use strict';

const express = require('express');
const {
  Group, Membership, Cycle, Contribution, Payout, User, Announcement, ActivityLog, Reminder, PaymentAttempt,
} = require('../models');
const { h, auth, validate } = require('../middleware');
const { err } = require('../utils/errors');
const v = require('../utils/validators');
const { FREQUENCIES, localParts } = require('../utils/dates');
const { breakdown, formatNaira } = require('../utils/money');
const { config } = require('../config/env');
const G = require('../services/groups');
const cycles = require('../services/cycles');
const payouts = require('../services/payouts');
const { notify, logActivity } = require('../services/notify');
const { sendSms } = require('../services/squadco');

const router = express.Router();
const { z } = v;

router.use(auth);

const MAX_MEMBERS = 100;

/** Keeps payoutOrder = all active participants, and payoutPosition = index + 1. */
async function syncPayoutOrder(group) {
  const participants = await Membership.find({ groupId: group._id, status: { $ne: 'removed' }, participant: true }).sort({ createdAt: 1 });
  const ids = new Set(participants.map((m) => String(m._id)));
  const order = group.payoutOrder.map(String).filter((id) => ids.has(id));
  for (const m of participants) if (!order.includes(String(m._id))) order.push(String(m._id));
  group.payoutOrder = order;
  await group.save();
  await Promise.all(
    order.map((id, i) => Membership.updateOne({ _id: id }, { $set: { payoutPosition: i + 1 } })),
  );
  await Membership.updateMany(
    { groupId: group._id, $or: [{ participant: false }, { status: 'removed' }] },
    { $unset: { payoutPosition: 1 } },
  );
  return order;
}

function assertDraft(group) {
  if (group.status !== 'draft') throw err('GROUP_NOT_DRAFT');
}

async function activeMemberships(groupId) {
  return Membership.find({ groupId, status: { $ne: 'removed' } });
}

async function draftView(group) {
  const ms = await activeMemberships(group._id);
  return {
    group: G.groupSummary(group),
    setup: G.setupStatus(group, ms),
    members: await G.listMembers(group._id),
  };
}

// ============================================================ List / create / join

/** Groups tab. An empty array is the "No groups" empty state, not an error. */
router.get(
  '/',
  h(async (req, res) => {
    const memberships = await Membership.find({ userId: req.user._id, status: 'joined' });
    const groups = await Group.find({ _id: { $in: memberships.map((m) => m.groupId) } }).sort({ updatedAt: -1 });
    const byGroup = new Map(memberships.map((m) => [String(m.groupId), m]));
    const out = [];
    for (const g of groups) {
      const m = byGroup.get(String(g._id));
      const cycle = await G.currentCycle(g);
      const mine = cycle && (await Contribution.findOne({ cycleId: cycle._id, membershipId: m._id }));
      out.push({
        ...G.groupSummary(g),
        viewerRole: m.role,
        myPayoutPosition: m.payoutPosition || null,
        currentCycle: G.cycleView(cycle),
        myContribution: mine ? { id: String(mine._id), amountDue: mine.amountDue, amountPaid: mine.amountPaid, outstanding: mine.outstandingAmount, status: mine.status } : null,
      });
    }
    res.json({ groups: out });
  }),
);

/** Create Group — Basics (1/5). The caller becomes the coordinator. */
router.post(
  '/',
  validate(
    z.object({
      name: z.string().trim().min(3).max(60),
      contributionAmount: v.kobo.min(100 * 100, 'Minimum contribution is ₦100'),
      description: z.string().trim().max(280).optional(),
      coordinatorParticipates: z.boolean().default(true),
    }),
  ),
  h(async (req, res) => {
    const group = await Group.create({
      ...req.body,
      coordinatorId: req.user._id,
      inviteCode: await G.uniqueInviteCode(),
      platformFeeBps: config.money.platformFeeBps,
    });
    await Membership.create({
      groupId: group._id,
      userId: req.user._id,
      role: 'coordinator',
      participant: req.body.coordinatorParticipates,
      status: 'joined',
      joinedAt: new Date(),
    });
    await syncPayoutOrder(group);
    res.status(201).json(await draftView(group));
  }),
);

const codeSchema = z.object({ code: z.string().trim().min(4).max(200) });

async function resolveInvite(code, user) {
  const group = await Group.findOne({ inviteCode: G.normaliseInviteCode(code) });
  if (!group || group.status === 'completed') throw err('INVITE_INVALID');
  const existing = await Membership.findOne({ groupId: group._id, userId: user._id, status: 'joined' });
  if (existing) throw err('ALREADY_MEMBER', undefined, { details: { groupId: String(group._id) } });
  const reserved = await Membership.findOne({
    groupId: group._id,
    status: { $in: ['invited', 'pending'] },
    $or: [{ userId: user._id }, { invitePhone: user.phone }],
  });
  let offeredPosition;
  if (reserved) {
    offeredPosition = reserved.participant ? reserved.payoutPosition : null;
  } else {
    if (group.status !== 'draft') throw err('GROUP_FULL', 'This group has started and all places are taken.');
    const count = await Membership.countDocuments({ groupId: group._id, status: { $ne: 'removed' }, participant: true });
    const cap = group.memberCount || MAX_MEMBERS;
    if (count >= cap) throw err('GROUP_FULL');
    offeredPosition = count + 1;
  }
  return { group, reserved, offeredPosition };
}

/** Join Group step 2: preview before confirming. */
router.post(
  '/join/preview',
  validate(codeSchema),
  h(async (req, res) => {
    const { group, offeredPosition } = await resolveInvite(req.body.code, req.user);
    const coordinator = await User.findById(group.coordinatorId);
    const joinedCount = await Membership.countDocuments({ groupId: group._id, status: 'joined', participant: true });
    res.json({
      group: {
        id: String(group._id),
        name: group.name,
        description: group.description,
        status: group.status,
        contributionAmount: group.contributionAmount,
        cycleFrequency: group.cycleFrequency,
        memberCount: group.memberCount,
        expectedCycleTotal: group.expectedCycleTotal,
        firstDueDate: group.firstDueDate,
        coordinatorName: coordinator && coordinator.name,
        joinedCount,
      },
      perMemberCharge: group.contributionAmount ? breakdown(group.contributionAmount, group.platformFeeBps) : null,
      offeredPosition,
      positionIsFinal: group.status !== 'draft',
    });
  }),
);

/** Join Group step 3 → Join Successful. */
router.post(
  '/join',
  validate(codeSchema),
  h(async (req, res) => {
    const { group, reserved } = await resolveInvite(req.body.code, req.user);
    let membership;
    if (reserved) {
      membership = await Membership.findOneAndUpdate(
        { _id: reserved._id, status: { $in: ['invited', 'pending'] } },
        { $set: { userId: req.user._id, status: 'joined', joinedAt: new Date() } },
        { new: true },
      );
      if (!membership) throw err('CONFLICT', 'This invite was just used. Try again.');
      // Money records created before the member joined are attached to them now.
      await Contribution.updateMany({ membershipId: membership._id }, { $set: { userId: req.user._id } });
      await Cycle.updateMany({ recipientMembershipId: membership._id }, { $set: { recipientUserId: req.user._id } });
      await Payout.updateMany({ recipientMembershipId: membership._id }, { $set: { recipientUserId: req.user._id } });
    } else {
      membership = await Membership.create({
        groupId: group._id,
        userId: req.user._id,
        role: 'member',
        status: 'joined',
        joinedAt: new Date(),
      });
      await syncPayoutOrder(group);
      // Guard the race where two people take the last place at once.
      const count = await Membership.countDocuments({ groupId: group._id, status: { $ne: 'removed' }, participant: true });
      if (group.memberCount && count > group.memberCount) {
        await Membership.updateOne({ _id: membership._id }, { $set: { status: 'removed', removedUserId: req.user._id }, $unset: { userId: 1 } });
        await syncPayoutOrder(await Group.findById(group._id));
        throw err('GROUP_FULL');
      }
      membership = await Membership.findById(membership._id);
    }
    await logActivity(group._id, req.user._id, 'member_joined', `${req.user.name} joined the group.`);
    await notify([group.coordinatorId], {
      type: 'member_joined',
      title: `${group.name}: new member`,
      body: `${req.user.name} joined${membership.payoutPosition ? ` at position ${membership.payoutPosition}` : ''}.`,
      groupId: group._id,
    });
    const fresh = await Group.findById(group._id);
    const cycle = await G.currentCycle(fresh);
    res.status(201).json({
      group: G.groupSummary(fresh),
      membership: membership.toJSON(),
      payoutPosition: membership.payoutPosition || null,
      firstDueDate: (cycle && cycle.dueDate) || fresh.firstDueDate || null,
    });
  }),
);

// ============================================================ Group overview

router.get(
  '/:id',
  h(async (req, res) => {
    const { group, membership, isCoordinator } = await G.loadGroupForUser(req.params.id, req.user);
    const cycle = await G.currentCycle(group);
    const roster = cycle ? await G.paymentRoster(cycle) : null;
    const members = await G.listMembers(group._id);
    const mine = cycle && membership && (await Contribution.findOne({ cycleId: cycle._id, membershipId: membership._id }));
    res.json({
      group: G.groupSummary(group),
      viewerRole: isCoordinator ? 'coordinator' : 'member',
      viewerLabel: isCoordinator ? 'You manage this group' : 'Member-only group',
      myMembership: membership ? membership.toJSON() : null,
      myContribution: mine ? { ...mine.toJSON(), outstandingAmount: mine.outstandingAmount } : null,
      currentCycle: G.cycleView(cycle),
      progress: roster
        ? {
            expected: cycle.expectedTotal,
            confirmed: cycle.confirmedReceived,
            outstanding: cycle.outstandingAmount,
            percentReceived: cycle.percentReceived,
            paidCount: roster.paidCount,
            totalMembers: roster.members.length,
          }
        : null,
      nextRecipient: await G.nextRecipient(group),
      membersPreview: members.filter((m) => m.status !== 'removed').slice(0, 5),
      memberTotal: members.length,
      setup: group.status === 'draft' ? G.setupStatus(group, await activeMemberships(group._id)) : undefined,
    });
  }),
);

router.get(
  '/:id/info',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user);
    const coordinator = await User.findById(group.coordinatorId);
    res.json({
      group: G.groupSummary(group),
      coordinator: coordinator ? { id: String(coordinator._id), name: coordinator.name, phone: coordinator.phone } : null,
      rules: group.rules,
      policies: [
        'Amount and turn order cannot change after the group starts.',
        `A ${group.platformFeeBps / 100}% TurnByTurn fee is added on top of each contribution; payouts are never reduced.`,
        'Payments go through TurnByTurn’s payment partner (Squadco), not the group organiser.',
        'A payout is released only after the whole cycle has been paid.',
      ],
    });
  }),
);

// ============================================================ Draft wizard (coordinator)

const draftSchema = z
  .object({
    name: z.string().trim().min(3).max(60),
    description: z.string().trim().max(280),
    contributionAmount: v.kobo.min(100 * 100, 'Minimum contribution is ₦100'),
    cycleFrequency: z.enum(FREQUENCIES),
    firstDueDate: z.coerce.date(),
    memberCount: z.number().int().min(2).max(MAX_MEMBERS),
    coordinatorParticipates: z.boolean(),
    rules: z.array(z.string().trim().min(1).max(200)).max(20),
  })
  .partial()
  .strict();

function startOfTodayLagos() {
  const p = localParts(new Date());
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - 3600000);
}

/** Basics (1/5) and Cycle (2/5): progressive, partial updates. */
router.patch(
  '/:id/draft',
  validate(draftSchema),
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user, { coordinator: true });
    assertDraft(group);
    const body = req.body;
    if (body.firstDueDate && body.firstDueDate < startOfTodayLagos()) {
      throw err('VALIDATION_ERROR', 'First due date cannot be in the past.', { details: [{ field: 'firstDueDate', message: 'Pick today or a later date' }] });
    }
    if (body.memberCount) {
      const count = await Membership.countDocuments({ groupId: group._id, status: { $ne: 'removed' }, participant: true });
      if (body.memberCount < count) {
        throw err('VALIDATION_ERROR', `You already have ${count} members. Remove some first.`, { details: [{ field: 'memberCount', message: 'Below current member count' }] });
      }
    }
    group.set(body);
    await group.save();
    if (body.coordinatorParticipates !== undefined) {
      await Membership.updateOne({ groupId: group._id, userId: group.coordinatorId }, { $set: { participant: body.coordinatorParticipates } });
      await syncPayoutOrder(group);
    }
    res.json(await draftView(group));
  }),
);

router.get(
  '/:id/setup',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user, { coordinator: true });
    res.json(await draftView(group));
  }),
);

/** Members (3/5): add a member by phone. Existing users get an in-app invite; others an SMS. */
router.post(
  '/:id/members',
  validate(z.object({ phone: v.phone, name: z.string().trim().min(2).max(80).optional() })),
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user, { coordinator: true });
    assertDraft(group);
    const { phone, name } = req.body;
    const count = await Membership.countDocuments({ groupId: group._id, status: { $ne: 'removed' }, participant: true });
    if (count >= (group.memberCount || MAX_MEMBERS)) throw err('GROUP_FULL', 'Increase the member count to add more people.');

    const existingUser = await User.findOne({ phone, status: 'active' });
    const dup = await Membership.findOne({
      groupId: group._id,
      status: { $ne: 'removed' },
      $or: [{ invitePhone: phone }, ...(existingUser ? [{ userId: existingUser._id }] : [])],
    });
    if (dup) throw err('CONFLICT', 'This person is already in the group.');

    const membership = await Membership.create({
      groupId: group._id,
      userId: existingUser ? existingUser._id : undefined,
      role: 'member',
      status: existingUser ? 'invited' : 'pending',
      inviteName: name || (existingUser && existingUser.name),
      invitePhone: phone,
      invitedBy: req.user._id,
    });
    await syncPayoutOrder(group);
    const message = `${req.user.name} invited you to "${group.name}" on TurnByTurn (${formatNaira(group.contributionAmount)} per cycle). Join with code ${group.inviteCode}.`;
    if (existingUser) {
      await notify([existingUser._id], { type: 'group_invite', title: 'Group invite', body: message, groupId: group._id, data: { inviteCode: group.inviteCode } });
    } else {
      await sendSms(phone, message).catch((e) => console.error('[groups] invite SMS failed:', e.message));
    }
    await logActivity(group._id, req.user._id, 'member_invited', `${req.user.name} invited ${name || phone}.`);
    res.status(201).json({ membership: (await Membership.findById(membership._id)).toJSON(), ...(await draftView(group)) });
  }),
);

router.delete(
  '/:id/members/:membershipId',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user, { coordinator: true });
    assertDraft(group);
    const m = await Membership.findOne({ _id: req.params.membershipId, groupId: group._id, status: { $ne: 'removed' } });
    if (!m) throw err('NOT_FOUND', 'Member not found.');
    if (m.role === 'coordinator') throw err('CONFLICT', 'The coordinator cannot be removed.');
    m.status = 'removed';
    m.removedUserId = m.userId;
    m.userId = undefined;
    await m.save();
    await syncPayoutOrder(group);
    res.json(await draftView(group));
  }),
);

/** Payout Order (4/5): full permutation of participant membership ids. */
router.put(
  '/:id/payout-order',
  validate(z.object({ order: z.array(v.objectId).min(1) })),
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user, { coordinator: true });
    assertDraft(group);
    const current = new Set(group.payoutOrder.map(String));
    const next = req.body.order;
    if (next.length !== current.size || new Set(next).size !== next.length || !next.every((id) => current.has(id))) {
      throw err('VALIDATION_ERROR', 'Order must list every member exactly once.', { details: [{ field: 'order', message: 'Not a permutation of the members' }] });
    }
    group.payoutOrder = next;
    await group.save();
    await syncPayoutOrder(group);
    res.json(await draftView(group));
  }),
);

/** Review (5/5): read-only summary + the immutability warning. */
router.get(
  '/:id/review',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user, { coordinator: true });
    const view = await draftView(group);
    const order = view.members.filter((m) => m.participant && m.payoutPosition).sort((a, b) => a.payoutPosition - b.payoutPosition);
    res.json({
      ...view,
      summary: {
        name: group.name,
        contributionAmount: group.contributionAmount,
        cycleFrequency: group.cycleFrequency,
        firstDueDate: group.firstDueDate,
        memberCount: group.memberCount,
        expectedCycleTotal: group.expectedCycleTotal,
        platformFeePercent: group.platformFeeBps / 100,
        perMemberCharge: group.contributionAmount ? breakdown(group.contributionAmount, group.platformFeeBps) : null,
        payoutOrder: order,
      },
      warning: 'Amount and turn order cannot change after the group starts.',
      paymentNote: 'Payments go through TurnByTurn’s payment partner (Squadco), not the group organiser.',
    });
  }),
);

/** Activated: locks amount + order, opens cycle 1, unlocks invite sharing. */
router.post(
  '/:id/activate',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user, { coordinator: true });
    assertDraft(group);
    await syncPayoutOrder(group);
    const setup = G.setupStatus(group, await activeMemberships(group._id));
    if (!setup.readyToActivate) throw err('GROUP_SETUP_INCOMPLETE', undefined, { details: { missing: setup.missing } });
    if (group.firstDueDate < startOfTodayLagos()) {
      throw err('GROUP_SETUP_INCOMPLETE', 'First due date has passed. Pick a new date.', { details: { missing: ['firstDueDate'] } });
    }
    const locked = await Group.findOneAndUpdate(
      { _id: group._id, status: 'draft' },
      { $set: { status: 'active', activatedAt: new Date() } },
      { new: true },
    );
    if (!locked) throw err('GROUP_NOT_DRAFT');
    const cycle = await cycles.openCycle(locked, 1);
    await logActivity(locked._id, req.user._id, 'group_activated', `${req.user.name} started the group. Amount and turn order are now locked.`);
    const ms = await Membership.find({ groupId: locked._id, status: 'joined', userId: { $ne: req.user._id } });
    await notify(
      ms.map((m) => m.userId),
      {
        type: 'group_activated',
        title: `${locked.name} has started`,
        body: `First contribution of ${formatNaira(locked.contributionAmount)} is due ${cycle.dueDate.toDateString()}.`,
        groupId: locked._id,
      },
    );
    res.json({
      group: G.groupSummary(locked),
      currentCycle: G.cycleView(cycle),
      invite: { code: locked.inviteCode, link: `https://turnbyturn.app/join/${locked.inviteCode}` },
      paymentNote: 'Payments go through TurnByTurn’s payment partner (Squadco), not the group organiser.',
    });
  }),
);

// ============================================================ Members

router.get(
  '/:id/members',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user);
    res.json({ members: await G.listMembers(group._id), memberCount: group.memberCount });
  }),
);

/** Member Detail: per-cycle required / received / due. Coordinator, or the member themself. */
router.get(
  '/:id/members/:membershipId',
  h(async (req, res) => {
    const { group, membership, isCoordinator } = await G.loadGroupForUser(req.params.id, req.user);
    const target = await Membership.findOne({ _id: req.params.membershipId, groupId: group._id }).populate('userId', 'name phone profilePhotoFileId');
    if (!target) throw err('NOT_FOUND', 'Member not found.');
    if (!isCoordinator && !req.user.isAdmin && String(target._id) !== String(membership && membership._id)) throw err('ACCESS_DENIED');
    const contributions = await Contribution.find({ membershipId: target._id }).populate('cycleId');
    const history = contributions
      .filter((c) => c.cycleId)
      .sort((a, b) => a.cycleId.cycleNumber - b.cycleId.cycleNumber)
      .map((c) => ({
        cycleId: String(c.cycleId._id),
        cycleNumber: c.cycleId.cycleNumber,
        periodLabel: c.cycleId.periodLabel,
        dueDate: c.cycleId.dueDate,
        required: c.amountDue,
        received: c.amountPaid,
        due: Math.max(0, c.amountDue - c.amountPaid),
        status: c.status,
      }));
    const payments = await PaymentAttempt.find({ contributionId: { $in: contributions.map((c) => c._id) }, status: 'success' }).sort({ confirmedAt: -1 });
    const current = history[history.length - 1] || null;
    res.json({
      member: G.memberDisplay(target),
      currentState: current,
      totals: {
        required: history.reduce((s, x) => s + x.required, 0),
        received: history.reduce((s, x) => s + x.received, 0),
        due: history.reduce((s, x) => s + x.due, 0),
      },
      history,
      payments: payments.map((p) => ({ reference: p.reference, amount: p.amountCredited, kind: p.kind, paidAt: p.confirmedAt, cycleId: String(p.cycleId) })),
    });
  }),
);

router.get(
  '/:id/invite',
  h(async (req, res) => {
    const { group, isCoordinator } = await G.loadGroupForUser(req.params.id, req.user);
    const link = `https://turnbyturn.app/join/${group.inviteCode}`;
    res.json({
      code: group.inviteCode,
      link,
      canShare: isCoordinator,
      shareMessage: `Join "${group.name}" on TurnByTurn: ${formatNaira(group.contributionAmount || 0)} per ${group.cycleFrequency ? group.cycleFrequency.replace('ly', '') : 'cycle'}. Use code ${group.inviteCode} or open ${link}`,
    });
  }),
);

// ============================================================ Turn order, cycles, payment status

router.get(
  '/:id/payout-order',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user);
    const members = await G.listMembers(group._id);
    const byId = new Map(members.map((m) => [m.membershipId, m]));
    const payoutDocs = await Payout.find({ groupId: group._id }).populate('cycleId', 'cycleNumber dueDate periodLabel');
    const payoutByMembership = new Map(payoutDocs.map((p) => [String(p.recipientMembershipId), p]));
    const order = group.payoutOrder.map((id, i) => {
      const p = payoutByMembership.get(String(id));
      return {
        position: i + 1,
        ...byId.get(String(id)),
        isMe: byId.get(String(id)) && byId.get(String(id)).userId === String(req.user._id),
        cycle: p && p.cycleId ? { number: p.cycleId.cycleNumber, dueDate: p.cycleId.dueDate, periodLabel: p.cycleId.periodLabel } : null,
        payoutStatus: p ? p.status : 'upcoming',
      };
    });
    res.json({
      locked: group.status !== 'draft',
      policy: 'Amount and turn order cannot change after the group starts.',
      order,
    });
  }),
);

router.get(
  '/:id/cycles',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user);
    const list = await Cycle.find({ groupId: group._id }).sort({ cycleNumber: 1 });
    res.json({ cycles: list.map(G.cycleView), totalCycles: group.payoutOrder.length });
  }),
);

/** Cycle Progress: expected vs confirmed vs outstanding, % received, deadline. */
router.get(
  '/:id/cycles/current',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user);
    const cycle = await G.currentCycle(group);
    if (!cycle) return res.json({ cycle: null });
    const roster = await G.paymentRoster(cycle);
    const payout = await Payout.findOne({ cycleId: cycle._id });
    return res.json({
      ...roster,
      outstandingMembers: roster.members.filter((m) => m.outstanding > 0),
      payout: payout ? await payouts.describePayout(payout) : null,
    });
  }),
);

/** Payment Status / Who Has Paid. Defaults to the current cycle. */
router.get(
  '/:id/payment-status',
  validate(z.object({ cycleId: v.objectId.optional() }), 'query'),
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user);
    const cycle = req.query.cycleId
      ? await Cycle.findOne({ _id: req.query.cycleId, groupId: group._id })
      : await G.currentCycle(group);
    if (!cycle) return res.json({ cycle: null, members: [], paidCount: 0, unpaidCount: 0 });
    return res.json(await G.paymentRoster(cycle));
  }),
);

router.get(
  '/:id/payouts',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user);
    const list = await Payout.find({ groupId: group._id }).sort({ createdAt: 1 });
    res.json({ payouts: await Promise.all(list.map((p) => payouts.describePayout(p))) });
  }),
);

// ============================================================ Coordinator dashboard

router.get(
  '/:id/dashboard',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user, { coordinator: true });
    const cycle = await G.currentCycle(group);
    const roster = cycle ? await G.paymentRoster(cycle) : null;
    const payout = cycle ? await Payout.findOne({ cycleId: cycle._id }) : null;
    const recent = await ActivityLog.find({ groupId: group._id }).sort({ createdAt: -1 }).limit(5);
    res.json({
      group: G.groupSummary(group),
      currentCycle: G.cycleView(cycle),
      collected: cycle ? cycle.confirmedReceived : 0,
      expected: cycle ? cycle.expectedTotal : group.expectedCycleTotal,
      remaining: cycle ? cycle.outstandingAmount : group.expectedCycleTotal,
      paidCount: roster ? roster.paidCount : 0,
      unpaidCount: roster ? roster.unpaidCount : 0,
      outstandingMembers: roster ? roster.members.filter((m) => m.outstanding > 0) : [],
      nextRecipient: await G.nextRecipient(group),
      payout: payout ? await payouts.describePayout(payout) : null,
      recentActivity: recent.map((a) => a.toJSON()),
      quickLinks: ['payment-status', 'add-member', 'remind', 'turn-order', 'activity', 'announcements'],
    });
  }),
);

/** Group Settings: only non-financial fields are editable once active. */
router.patch(
  '/:id/settings',
  validate(
    z
      .object({
        name: z.string().trim().min(3).max(60),
        description: z.string().trim().max(280),
        rules: z.array(z.string().trim().min(1).max(200)).max(20),
      })
      .partial()
      .strict(),
  ),
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user, { coordinator: true });
    group.set(req.body);
    await group.save();
    await logActivity(group._id, req.user._id, 'settings_updated', `${req.user.name} updated the group settings.`);
    res.json({ group: G.groupSummary(group) });
  }),
);

// ============================================================ Announcements & activity

router.get(
  '/:id/announcements',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user);
    const list = await Announcement.find({ groupId: group._id }).sort({ createdAt: -1 }).limit(100).populate('authorId', 'name');
    res.json({
      announcements: list.map((a) => ({ ...a.toJSON(), authorId: String(a.authorId._id), authorName: a.authorId.name })),
    });
  }),
);

router.post(
  '/:id/announcements',
  validate(z.object({ title: z.string().trim().min(2).max(100), body: z.string().trim().min(2).max(2000) })),
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user, { coordinator: true });
    const a = await Announcement.create({ groupId: group._id, authorId: req.user._id, ...req.body });
    await logActivity(group._id, req.user._id, 'announcement', `${req.user.name} posted: ${a.title}`, { announcementId: a._id });
    const ms = await Membership.find({ groupId: group._id, status: 'joined', userId: { $ne: req.user._id } });
    await notify(
      ms.map((m) => m.userId),
      { type: 'announcement', title: `${group.name}: ${a.title}`, body: a.body.slice(0, 180), groupId: group._id, data: { announcementId: String(a._id) } },
    );
    res.status(201).json({ announcement: a.toJSON() });
  }),
);

router.get(
  '/:id/activity',
  validate(z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }), 'query'),
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user);
    const q = { groupId: group._id };
    if (req.query.before) q.createdAt = { $lt: req.query.before };
    const list = await ActivityLog.find(q).sort({ createdAt: -1 }).limit(req.query.limit).populate('actorId', 'name');
    res.json({
      activity: list.map((a) => ({ ...a.toJSON(), actorId: a.actorId ? String(a.actorId._id) : null, actorName: a.actorId ? a.actorId.name : 'TurnByTurn' })),
      nextBefore: list.length === req.query.limit ? list[list.length - 1].createdAt : null,
    });
  }),
);

// ============================================================ Reminders

router.get(
  '/:id/reminders',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user, { coordinator: true });
    const list = await Reminder.find({ groupId: group._id }).sort({ sentAt: -1 }).limit(50);
    res.json({ reminders: list.map((r) => r.toJSON()), cooldownHours: config.reminders.cooldownHours });
  }),
);

/**
 * Reminders → Reminder Sent. Nudges outstanding members (all, or the ones listed). Each member
 * can be nudged at most once per REMINDER_COOLDOWN_HOURS; members still cooling down are skipped.
 */
router.post(
  '/:id/reminders',
  validate(
    z.object({
      membershipIds: z.array(v.objectId).max(MAX_MEMBERS).optional(),
      message: z.string().trim().max(300).optional(),
      channels: z.array(z.enum(['push', 'sms', 'email'])).default(['push']),
    }),
  ),
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(req.params.id, req.user, { coordinator: true });
    if (group.status !== 'active') throw err('GROUP_NOT_ACTIVE');
    const cycle = await G.currentCycle(group);
    const owing = await cycles.outstandingContributions(cycle._id);
    let targets = owing;
    if (req.body.membershipIds) {
      const wanted = new Set(req.body.membershipIds);
      targets = owing.filter((c) => wanted.has(String(c.membershipId)));
    }
    const since = new Date(Date.now() - config.reminders.cooldownHours * 3600000);
    const recent = await Reminder.find({ groupId: group._id, kind: 'manual', sentAt: { $gte: since } });
    const lastSent = new Map();
    for (const r of recent) for (const id of r.targetMembershipIds) {
      const k = String(id);
      if (!lastSent.has(k) || lastSent.get(k) < r.sentAt) lastSent.set(k, r.sentAt);
    }
    const toSend = [];
    const skipped = [];
    for (const c of targets) {
      const last = lastSent.get(String(c.membershipId));
      if (last) {
        skipped.push({ membershipId: String(c.membershipId), reason: 'cooldown', nextAllowedAt: new Date(last.getTime() + config.reminders.cooldownHours * 3600000) });
      } else {
        toSend.push(c);
      }
    }
    if (!toSend.length) {
      throw err('REMINDER_COOLDOWN', targets.length ? undefined : 'Everyone selected has already paid.', { details: { skipped } });
    }
    const reminder = await Reminder.create({
      groupId: group._id,
      cycleId: cycle._id,
      sentBy: req.user._id,
      kind: 'manual',
      channels: ['in_app', ...req.body.channels],
      targetMembershipIds: toSend.map((c) => c.membershipId),
      message: req.body.message,
    });
    const body = req.body.message || `Your ${cycle.periodLabel} contribution for ${group.name} is due ${cycle.dueDate.toDateString()}.`;
    await notify(
      toSend.map((c) => c.userId),
      {
        type: 'payment_reminder',
        title: `Reminder from ${req.user.name}`,
        body,
        groupId: group._id,
        data: { cycleId: String(cycle._id) },
        email: req.body.channels.includes('email'),
        sms: req.body.channels.includes('sms') ? `${group.name}: ${body}` : false,
      },
    );
    // Members who haven't installed the app yet can only be reached by SMS.
    const pending = await Membership.find({ _id: { $in: toSend.filter((c) => !c.userId).map((c) => c.membershipId) } });
    await Promise.all(pending.map((m) => m.invitePhone && sendSms(m.invitePhone, `${group.name}: ${body} Join with code ${group.inviteCode}.`).catch(() => {})));
    await logActivity(group._id, req.user._id, 'reminder_sent', `${req.user.name} sent a reminder to ${toSend.length} member(s).`);
    res.status(201).json({ reminder: reminder.toJSON(), sentCount: toSend.length, skipped });
  }),
);

module.exports = router;
