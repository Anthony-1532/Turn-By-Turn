import express from 'express';
import type { Types } from 'mongoose';
import {
  Group, Membership, Cycle, Contribution, Payout, User, Announcement, ActivityLog, Reminder, PaymentAttempt,
  type GroupDoc, type UserDoc,
} from '../models';
import { h, auth, currentUser, param, parseBody, parseQuery } from '../middleware';
import { err } from '../utils/errors';
import * as v from '../utils/validators';
import { FREQUENCIES, startOfTodayLagos } from '../utils/dates';
import { breakdown, formatNaira } from '../utils/money';
import { config } from '../config/env';
import * as G from '../services/groups';
import * as cycles from '../services/cycles';
import * as payouts from '../services/payouts';
import { notify, logActivity } from '../services/notify';
import { sendSms } from '../services/squadco';

const router = express.Router();
const { z } = v;

router.use(auth);

const MAX_MEMBERS = 100;
const PAYMENT_NOTE = 'Payments go through TurnByTurn’s payment partner (Squadco), not the group organiser.';
const LOCK_POLICY = 'Amount and turn order cannot change after the group starts.';

const activeParticipants = (groupId: Types.ObjectId) => ({ groupId, status: { $ne: 'removed' as const }, participant: true });

/** Keeps payoutOrder = all active participants, and payoutPosition = index + 1. */
async function syncPayoutOrder(group: GroupDoc): Promise<string[]> {
  const participants = await Membership.find(activeParticipants(group._id)).sort({ createdAt: 1 });
  const ids = new Set(participants.map((m) => String(m._id)));
  const order = group.payoutOrder.map(String).filter((id) => ids.has(id));
  for (const m of participants) if (!order.includes(String(m._id))) order.push(String(m._id));
  group.set('payoutOrder', order);
  await group.save();
  await Promise.all(order.map((id, i) => Membership.updateOne({ _id: id }, { $set: { payoutPosition: i + 1 } })));
  await Membership.updateMany(
    { groupId: group._id, $or: [{ participant: false }, { status: 'removed' }] },
    { $unset: { payoutPosition: 1 } },
  );
  return order;
}

function assertDraft(group: GroupDoc): void {
  if (group.status !== 'draft') throw err('GROUP_NOT_DRAFT');
}

const activeMemberships = (groupId: Types.ObjectId) => Membership.find({ groupId, status: { $ne: 'removed' } });
const countParticipants = (groupId: Types.ObjectId) => Membership.countDocuments(activeParticipants(groupId));

async function draftView(group: GroupDoc) {
  return {
    group: G.groupSummary(group),
    setup: G.setupStatus(group, await activeMemberships(group._id)),
    members: await G.listMembers(group._id),
  };
}

const inviteInfo = (group: GroupDoc) => ({ code: group.inviteCode, link: G.inviteLink(group.inviteCode) });

// ============================================================ List / create / join

/** Groups tab. An empty array is the "No groups" empty state, not an error. */
router.get(
  '/',
  h(async (req, res) => {
    const memberships = await Membership.find({ userId: currentUser(req)._id, status: 'joined' });
    const groups = await Group.find({ _id: { $in: memberships.map((m) => m.groupId) } }).sort({ updatedAt: -1 });
    const byGroup = new Map(memberships.map((m) => [String(m.groupId), m]));
    const out = [];
    for (const g of groups) {
      const m = byGroup.get(String(g._id));
      if (!m) continue;
      const cycle = await G.currentCycle(g);
      const mine = cycle ? await Contribution.findOne({ cycleId: cycle._id, membershipId: m._id }) : null;
      out.push({
        ...G.groupSummary(g),
        viewerRole: m.role,
        myPayoutPosition: m.payoutPosition ?? null,
        currentCycle: G.cycleView(cycle),
        myContribution: mine
          ? { id: String(mine._id), amountDue: mine.amountDue, amountPaid: mine.amountPaid, outstanding: mine.outstandingAmount, status: mine.status }
          : null,
      });
    }
    res.json({ groups: out });
  }),
);

/** Create Group — Basics (1/5). The caller becomes the coordinator. */
router.post(
  '/',
  h(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(3).max(60),
        contributionAmount: v.kobo.min(100 * 100, 'Minimum contribution is ₦100'),
        description: z.string().trim().max(280).optional(),
        coordinatorParticipates: z.boolean().default(true),
      }),
      req,
    );
    const group = await Group.create({
      ...body,
      coordinatorId: user._id,
      inviteCode: await G.uniqueInviteCode(),
      platformFeeBps: config.money.platformFeeBps,
    });
    await Membership.create({
      groupId: group._id,
      userId: user._id,
      role: 'coordinator',
      participant: body.coordinatorParticipates,
      status: 'joined',
      joinedAt: new Date(),
    });
    await syncPayoutOrder(group);
    res.status(201).json(await draftView(group));
  }),
);

const codeSchema = z.object({ code: z.string().trim().min(4).max(200) });

async function resolveInvite(code: string, user: UserDoc) {
  const group = await Group.findOne({ inviteCode: G.normaliseInviteCode(code) });
  if (!group || group.status === 'completed') throw err('INVITE_INVALID');
  const existing = await Membership.findOne({ groupId: group._id, userId: user._id, status: 'joined' });
  if (existing) throw err('ALREADY_MEMBER', undefined, { details: { groupId: String(group._id) } });
  const reserved = await Membership.findOne({
    groupId: group._id,
    status: { $in: ['invited', 'pending'] },
    $or: [{ userId: user._id }, { invitePhone: user.phone }],
  });
  let offeredPosition: number | null;
  if (reserved) {
    offeredPosition = reserved.participant ? (reserved.payoutPosition ?? null) : null;
  } else {
    if (group.status !== 'draft') throw err('GROUP_FULL', 'This group has started and all places are taken.');
    const count = await countParticipants(group._id);
    if (count >= (group.memberCount ?? MAX_MEMBERS)) throw err('GROUP_FULL');
    offeredPosition = count + 1;
  }
  return { group, reserved, offeredPosition };
}

/** Join Group step 2: preview before confirming. */
router.post(
  '/join/preview',
  h(async (req, res) => {
    const { code } = parseBody(codeSchema, req);
    const { group, offeredPosition } = await resolveInvite(code, currentUser(req));
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
        coordinatorName: coordinator?.name ?? null,
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
  h(async (req, res) => {
    const user = currentUser(req);
    const { code } = parseBody(codeSchema, req);
    const { group, reserved } = await resolveInvite(code, user);
    let membership;
    if (reserved) {
      membership = await Membership.findOneAndUpdate(
        { _id: reserved._id, status: { $in: ['invited', 'pending'] } },
        { $set: { userId: user._id, status: 'joined', joinedAt: new Date() } },
        { new: true },
      );
      if (!membership) throw err('CONFLICT', 'This invite was just used. Try again.');
      // Money records created before the member joined are attached to them now.
      await Contribution.updateMany({ membershipId: membership._id }, { $set: { userId: user._id } });
      await Cycle.updateMany({ recipientMembershipId: membership._id }, { $set: { recipientUserId: user._id } });
      await Payout.updateMany({ recipientMembershipId: membership._id }, { $set: { recipientUserId: user._id } });
    } else {
      const created = await Membership.create({ groupId: group._id, userId: user._id, role: 'member', status: 'joined', joinedAt: new Date() });
      await syncPayoutOrder(group);
      // Guard the race where two people take the last place at once.
      const count = await countParticipants(group._id);
      if (group.memberCount && count > group.memberCount) {
        await Membership.updateOne({ _id: created._id }, { $set: { status: 'removed', removedUserId: user._id }, $unset: { userId: 1 } });
        const fresh = await Group.findById(group._id);
        if (fresh) await syncPayoutOrder(fresh);
        throw err('GROUP_FULL');
      }
      membership = await Membership.findById(created._id);
      if (!membership) throw err('CONFLICT');
    }
    await logActivity(group._id, user._id, 'member_joined', `${user.name} joined the group.`);
    await notify([group.coordinatorId], {
      type: 'member_joined',
      title: `${group.name}: new member`,
      body: `${user.name} joined${membership.payoutPosition ? ` at position ${membership.payoutPosition}` : ''}.`,
      groupId: group._id,
    });
    const fresh = (await Group.findById(group._id)) ?? group;
    const cycle = await G.currentCycle(fresh);
    res.status(201).json({
      group: G.groupSummary(fresh),
      membership: membership.toJSON(),
      payoutPosition: membership.payoutPosition ?? null,
      firstDueDate: cycle?.dueDate ?? fresh.firstDueDate ?? null,
    });
  }),
);

// ============================================================ Group overview

router.get(
  '/:id',
  h(async (req, res) => {
    const { group, membership, isCoordinator } = await G.loadGroupForUser(param(req, 'id'), currentUser(req));
    const cycle = await G.currentCycle(group);
    const roster = cycle ? await G.paymentRoster(cycle) : null;
    const members = await G.listMembers(group._id);
    const mine = cycle && membership ? await Contribution.findOne({ cycleId: cycle._id, membershipId: membership._id }) : null;
    res.json({
      group: G.groupSummary(group),
      viewerRole: isCoordinator ? 'coordinator' : 'member',
      viewerLabel: isCoordinator ? 'You manage this group' : 'Member-only group',
      myMembership: membership?.toJSON() ?? null,
      myContribution: mine ? { ...mine.toJSON(), outstandingAmount: mine.outstandingAmount } : null,
      currentCycle: G.cycleView(cycle),
      progress:
        cycle && roster
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
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req));
    const coordinator = await User.findById(group.coordinatorId);
    res.json({
      group: G.groupSummary(group),
      coordinator: coordinator ? { id: String(coordinator._id), name: coordinator.name, phone: coordinator.phone } : null,
      rules: group.rules,
      policies: [
        LOCK_POLICY,
        `A ${group.platformFeeBps / 100}% TurnByTurn fee is added on top of each contribution; payouts are never reduced.`,
        PAYMENT_NOTE,
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

/** Basics (1/5) and Cycle (2/5): progressive, partial updates. */
router.patch(
  '/:id/draft',
  h(async (req, res) => {
    const body = parseBody(draftSchema, req);
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req), { coordinator: true });
    assertDraft(group);
    if (body.firstDueDate && body.firstDueDate < startOfTodayLagos()) {
      throw err('VALIDATION_ERROR', 'First due date cannot be in the past.', {
        details: [{ field: 'firstDueDate', message: 'Pick today or a later date' }],
      });
    }
    if (body.memberCount) {
      const count = await countParticipants(group._id);
      if (body.memberCount < count) {
        throw err('VALIDATION_ERROR', `You already have ${count} members. Remove some first.`, {
          details: [{ field: 'memberCount', message: 'Below current member count' }],
        });
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
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req), { coordinator: true });
    res.json(await draftView(group));
  }),
);

/** Members (3/5): add a member by phone. Existing users get an in-app invite; others an SMS. */
router.post(
  '/:id/members',
  h(async (req, res) => {
    const user = currentUser(req);
    const { phone, name } = parseBody(z.object({ phone: v.phone, name: z.string().trim().min(2).max(80).optional() }), req);
    const { group } = await G.loadGroupForUser(param(req, 'id'), user, { coordinator: true });
    assertDraft(group);
    const count = await countParticipants(group._id);
    if (count >= (group.memberCount ?? MAX_MEMBERS)) throw err('GROUP_FULL', 'Increase the member count to add more people.');

    const existingUser = await User.findOne({ phone, status: 'active' });
    const dup = await Membership.findOne({
      groupId: group._id,
      status: { $ne: 'removed' },
      $or: [{ invitePhone: phone }, ...(existingUser ? [{ userId: existingUser._id }] : [])],
    });
    if (dup) throw err('CONFLICT', 'This person is already in the group.');

    const membership = await Membership.create({
      groupId: group._id,
      userId: existingUser?._id,
      role: 'member',
      status: existingUser ? 'invited' : 'pending',
      inviteName: name ?? existingUser?.name,
      invitePhone: phone,
      invitedBy: user._id,
    });
    await syncPayoutOrder(group);
    const message = `${user.name} invited you to "${group.name}" on TurnByTurn (${formatNaira(group.contributionAmount ?? 0)} per cycle). Join with code ${group.inviteCode}.`;
    if (existingUser) {
      await notify([existingUser._id], { type: 'group_invite', title: 'Group invite', body: message, groupId: group._id, data: { inviteCode: group.inviteCode } });
    } else {
      await sendSms(phone, message).catch((e: Error) => console.error('[groups] invite SMS failed:', e.message));
    }
    await logActivity(group._id, user._id, 'member_invited', `${user.name} invited ${name ?? phone}.`);
    const fresh = await Membership.findById(membership._id);
    res.status(201).json({ membership: fresh?.toJSON() ?? null, ...(await draftView(group)) });
  }),
);

router.delete(
  '/:id/members/:membershipId',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req), { coordinator: true });
    assertDraft(group);
    const m = await Membership.findOne({ _id: param(req, 'membershipId'), groupId: group._id, status: { $ne: 'removed' } });
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
  h(async (req, res) => {
    const { order } = parseBody(z.object({ order: z.array(v.objectId).min(1) }), req);
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req), { coordinator: true });
    assertDraft(group);
    const current = new Set(group.payoutOrder.map(String));
    if (order.length !== current.size || new Set(order).size !== order.length || !order.every((id) => current.has(id))) {
      throw err('VALIDATION_ERROR', 'Order must list every member exactly once.', {
        details: [{ field: 'order', message: 'Not a permutation of the members' }],
      });
    }
    group.set('payoutOrder', order);
    await group.save();
    await syncPayoutOrder(group);
    res.json(await draftView(group));
  }),
);

/** Review (5/5): read-only summary + the immutability warning. */
router.get(
  '/:id/review',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req), { coordinator: true });
    const view = await draftView(group);
    const payoutOrder = view.members
      .filter((m) => m.participant && m.payoutPosition)
      .sort((a, b) => (a.payoutPosition ?? 0) - (b.payoutPosition ?? 0));
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
        payoutOrder,
      },
      warning: LOCK_POLICY,
      paymentNote: PAYMENT_NOTE,
    });
  }),
);

/** Activated: locks amount + order, opens cycle 1, unlocks invite sharing. */
router.post(
  '/:id/activate',
  h(async (req, res) => {
    const user = currentUser(req);
    const { group } = await G.loadGroupForUser(param(req, 'id'), user, { coordinator: true });
    assertDraft(group);
    await syncPayoutOrder(group);
    const setup = G.setupStatus(group, await activeMemberships(group._id));
    if (!setup.readyToActivate) throw err('GROUP_SETUP_INCOMPLETE', undefined, { details: { missing: setup.missing } });
    if (!group.firstDueDate || group.firstDueDate < startOfTodayLagos()) {
      throw err('GROUP_SETUP_INCOMPLETE', 'First due date has passed. Pick a new date.', { details: { missing: ['firstDueDate'] } });
    }
    const locked = await Group.findOneAndUpdate(
      { _id: group._id, status: 'draft' },
      { $set: { status: 'active', activatedAt: new Date() } },
      { new: true },
    );
    if (!locked) throw err('GROUP_NOT_DRAFT');
    const cycle = await cycles.openCycle(locked, 1);
    await logActivity(locked._id, user._id, 'group_activated', `${user.name} started the group. Amount and turn order are now locked.`);
    const ms = await Membership.find({ groupId: locked._id, status: 'joined', userId: { $ne: user._id } });
    await notify(
      ms.map((m) => m.userId),
      {
        type: 'group_activated',
        title: `${locked.name} has started`,
        body: `First contribution of ${formatNaira(locked.contributionAmount ?? 0)} is due ${cycle.dueDate.toDateString()}.`,
        groupId: locked._id,
      },
    );
    res.json({ group: G.groupSummary(locked), currentCycle: G.cycleView(cycle), invite: inviteInfo(locked), paymentNote: PAYMENT_NOTE });
  }),
);

// ============================================================ Members

router.get(
  '/:id/members',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req));
    res.json({ members: await G.listMembers(group._id), memberCount: group.memberCount });
  }),
);

/** Member Detail: per-cycle required / received / due. Coordinator, or the member themself. */
router.get(
  '/:id/members/:membershipId',
  h(async (req, res) => {
    const user = currentUser(req);
    const { group, membership, isCoordinator } = await G.loadGroupForUser(param(req, 'id'), user);
    const target = await Membership.findOne({ _id: param(req, 'membershipId'), groupId: group._id }).populate<{
      userId: G.PopulatedUserLite | null;
    }>('userId', G.MEMBER_USER_FIELDS);
    if (!target) throw err('NOT_FOUND', 'Member not found.');
    if (!isCoordinator && !user.isAdmin && String(target._id) !== String(membership?._id)) throw err('ACCESS_DENIED');

    const contributions = await Contribution.find({ membershipId: target._id });
    const cycleDocs = await Cycle.find({ _id: { $in: contributions.map((c) => c.cycleId) } });
    const cycleById = new Map(cycleDocs.map((c) => [String(c._id), c]));
    const history = contributions
      .flatMap((c) => {
        const cy = cycleById.get(String(c.cycleId));
        if (!cy) return [];
        return [{
          cycleId: String(cy._id),
          cycleNumber: cy.cycleNumber,
          periodLabel: cy.periodLabel,
          dueDate: cy.dueDate,
          required: c.amountDue,
          received: c.amountPaid,
          due: Math.max(0, c.amountDue - c.amountPaid),
          status: c.status,
        }];
      })
      .sort((a, b) => a.cycleNumber - b.cycleNumber);
    const paymentsList = await PaymentAttempt.find({ contributionId: { $in: contributions.map((c) => c._id) }, status: 'success' }).sort({
      confirmedAt: -1,
    });
    res.json({
      member: G.memberDisplay(target),
      currentState: history[history.length - 1] ?? null,
      totals: {
        required: history.reduce((s, x) => s + x.required, 0),
        received: history.reduce((s, x) => s + x.received, 0),
        due: history.reduce((s, x) => s + x.due, 0),
      },
      history,
      payments: paymentsList.map((p) => ({ reference: p.reference, amount: p.amountCredited, kind: p.kind, paidAt: p.confirmedAt, cycleId: String(p.cycleId) })),
    });
  }),
);

router.get(
  '/:id/invite',
  h(async (req, res) => {
    const { group, isCoordinator } = await G.loadGroupForUser(param(req, 'id'), currentUser(req));
    const { code, link } = inviteInfo(group);
    const period = group.cycleFrequency ? group.cycleFrequency.replace('ly', '') : 'cycle';
    res.json({
      code,
      link,
      canShare: isCoordinator,
      shareMessage: `Join "${group.name}" on TurnByTurn: ${formatNaira(group.contributionAmount ?? 0)} per ${period}. Use code ${code} or open ${link}`,
    });
  }),
);

// ============================================================ Turn order, cycles, payment status

router.get(
  '/:id/payout-order',
  h(async (req, res) => {
    const user = currentUser(req);
    const { group } = await G.loadGroupForUser(param(req, 'id'), user);
    const members = await G.listMembers(group._id);
    const byId = new Map(members.map((m) => [m.membershipId, m]));
    const payoutDocs = await Payout.find({ groupId: group._id });
    const cycleDocs = await Cycle.find({ groupId: group._id });
    const cycleById = new Map(cycleDocs.map((c) => [String(c._id), c]));
    const payoutByMembership = new Map(payoutDocs.map((p) => [String(p.recipientMembershipId), p]));
    const order = group.payoutOrder.map((id, i) => {
      const member = byId.get(String(id));
      const p = payoutByMembership.get(String(id));
      const cy = p ? cycleById.get(String(p.cycleId)) : undefined;
      return {
        position: i + 1,
        ...member,
        isMe: member?.userId === String(user._id),
        cycle: cy ? { number: cy.cycleNumber, dueDate: cy.dueDate, periodLabel: cy.periodLabel } : null,
        payoutStatus: p ? p.status : 'upcoming',
      };
    });
    res.json({ locked: group.status !== 'draft', policy: LOCK_POLICY, order });
  }),
);

router.get(
  '/:id/cycles',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req));
    const list = await Cycle.find({ groupId: group._id }).sort({ cycleNumber: 1 });
    res.json({ cycles: list.map((c) => G.cycleView(c)), totalCycles: group.payoutOrder.length });
  }),
);

/** Cycle Progress: expected vs confirmed vs outstanding, % received, deadline. */
router.get(
  '/:id/cycles/current',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req));
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
  h(async (req, res) => {
    const { cycleId } = parseQuery(z.object({ cycleId: v.objectId.optional() }), req);
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req));
    const cycle = cycleId ? await Cycle.findOne({ _id: cycleId, groupId: group._id }) : await G.currentCycle(group);
    if (!cycle) return res.json({ cycle: null, members: [], paidCount: 0, unpaidCount: 0 });
    return res.json(await G.paymentRoster(cycle));
  }),
);

router.get(
  '/:id/payouts',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req));
    const list = await Payout.find({ groupId: group._id }).sort({ createdAt: 1 });
    res.json({ payouts: await Promise.all(list.map((p) => payouts.describePayout(p))) });
  }),
);

// ============================================================ Coordinator dashboard

router.get(
  '/:id/dashboard',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req), { coordinator: true });
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
      paidCount: roster?.paidCount ?? 0,
      unpaidCount: roster?.unpaidCount ?? 0,
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
  h(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z
        .object({
          name: z.string().trim().min(3).max(60),
          description: z.string().trim().max(280),
          rules: z.array(z.string().trim().min(1).max(200)).max(20),
        })
        .partial()
        .strict(),
      req,
    );
    const { group } = await G.loadGroupForUser(param(req, 'id'), user, { coordinator: true });
    group.set(body);
    await group.save();
    await logActivity(group._id, user._id, 'settings_updated', `${user.name} updated the group settings.`);
    res.json({ group: G.groupSummary(group) });
  }),
);

// ============================================================ Announcements & activity

router.get(
  '/:id/announcements',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req));
    const list = await Announcement.find({ groupId: group._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate<{ authorId: { _id: Types.ObjectId; name: string } | null }>('authorId', 'name');
    res.json({
      announcements: list.map((a) => ({
        ...a.toJSON(),
        authorId: a.authorId ? String(a.authorId._id) : null,
        authorName: a.authorId?.name ?? null,
      })),
    });
  }),
);

router.post(
  '/:id/announcements',
  h(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(z.object({ title: z.string().trim().min(2).max(100), body: z.string().trim().min(2).max(2000) }), req);
    const { group } = await G.loadGroupForUser(param(req, 'id'), user, { coordinator: true });
    const a = await Announcement.create({ groupId: group._id, authorId: user._id, ...body });
    await logActivity(group._id, user._id, 'announcement', `${user.name} posted: ${a.title}`, { announcementId: a._id });
    const ms = await Membership.find({ groupId: group._id, status: 'joined', userId: { $ne: user._id } });
    await notify(
      ms.map((m) => m.userId),
      { type: 'announcement', title: `${group.name}: ${a.title}`, body: a.body.slice(0, 180), groupId: group._id, data: { announcementId: String(a._id) } },
    );
    res.status(201).json({ announcement: a.toJSON() });
  }),
);

router.get(
  '/:id/activity',
  h(async (req, res) => {
    const { before, limit } = parseQuery(
      z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }),
      req,
    );
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req));
    const list = await ActivityLog.find({ groupId: group._id, ...(before ? { createdAt: { $lt: before } } : {}) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate<{ actorId: { _id: Types.ObjectId; name: string } | null }>('actorId', 'name');
    const last = list[list.length - 1];
    res.json({
      activity: list.map((a) => ({
        ...a.toJSON(),
        actorId: a.actorId ? String(a.actorId._id) : null,
        actorName: a.actorId?.name ?? 'TurnByTurn',
      })),
      nextBefore: list.length === limit && last ? last.createdAt : null,
    });
  }),
);

// ============================================================ Reminders

router.get(
  '/:id/reminders',
  h(async (req, res) => {
    const { group } = await G.loadGroupForUser(param(req, 'id'), currentUser(req), { coordinator: true });
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
  h(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        membershipIds: z.array(v.objectId).max(MAX_MEMBERS).optional(),
        message: z.string().trim().max(300).optional(),
        channels: z.array(z.enum(['push', 'sms', 'email'])).default(['push']),
      }),
      req,
    );
    const { group } = await G.loadGroupForUser(param(req, 'id'), user, { coordinator: true });
    if (group.status !== 'active') throw err('GROUP_NOT_ACTIVE');
    const cycle = await G.currentCycle(group);
    if (!cycle) throw err('GROUP_NOT_ACTIVE');
    const owing = await cycles.outstandingContributions(cycle._id);
    const wanted = body.membershipIds ? new Set(body.membershipIds) : null;
    const targets = wanted ? owing.filter((c) => wanted.has(String(c.membershipId))) : owing;

    const cooldownMs = config.reminders.cooldownHours * 3600000;
    const recent = await Reminder.find({ groupId: group._id, kind: 'manual', sentAt: { $gte: new Date(Date.now() - cooldownMs) } });
    const lastSent = new Map<string, Date>();
    for (const r of recent) {
      for (const id of r.targetMembershipIds) {
        const k = String(id);
        const prev = lastSent.get(k);
        if (!prev || prev < r.sentAt) lastSent.set(k, r.sentAt);
      }
    }
    const toSend = targets.filter((c) => !lastSent.has(String(c.membershipId)));
    const skipped = targets
      .filter((c) => lastSent.has(String(c.membershipId)))
      .map((c) => ({
        membershipId: String(c.membershipId),
        reason: 'cooldown' as const,
        nextAllowedAt: new Date(lastSent.get(String(c.membershipId))!.getTime() + cooldownMs),
      }));
    if (!toSend.length) {
      throw err('REMINDER_COOLDOWN', targets.length ? undefined : 'Everyone selected has already paid.', { details: { skipped } });
    }
    const reminder = await Reminder.create({
      groupId: group._id,
      cycleId: cycle._id,
      sentBy: user._id,
      kind: 'manual',
      channels: ['in_app', ...body.channels],
      targetMembershipIds: toSend.map((c) => c.membershipId),
      message: body.message,
    });
    const text = body.message ?? `Your ${cycle.periodLabel} contribution for ${group.name} is due ${cycle.dueDate.toDateString()}.`;
    await notify(
      toSend.map((c) => c.userId),
      {
        type: 'payment_reminder',
        title: `Reminder from ${user.name}`,
        body: text,
        groupId: group._id,
        data: { cycleId: String(cycle._id) },
        email: body.channels.includes('email'),
        sms: body.channels.includes('sms') ? `${group.name}: ${text}` : false,
      },
    );
    // Members who haven't installed the app yet can only be reached by SMS.
    const pending = await Membership.find({ _id: { $in: toSend.filter((c) => !c.userId).map((c) => c.membershipId) } });
    await Promise.all(
      pending.map((m) =>
        m.invitePhone ? sendSms(m.invitePhone, `${group.name}: ${text} Join with code ${group.inviteCode}.`).catch(() => undefined) : undefined,
      ),
    );
    await logActivity(group._id, user._id, 'reminder_sent', `${user.name} sent a reminder to ${toSend.length} member(s).`);
    res.status(201).json({ reminder: reminder.toJSON(), sentCount: toSend.length, skipped });
  }),
);

export default router;
