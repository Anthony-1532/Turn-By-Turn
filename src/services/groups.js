'use strict';

const crypto = require('crypto');
const { Group, Membership, Cycle, Contribution, Payout, User } = require('../models');
const { err } = require('../utils/errors');
const { breakdown } = require('../utils/money');

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

function generateInviteCode(len = 6) {
  let s = '';
  for (let i = 0; i < len; i += 1) s += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  return s;
}

async function uniqueInviteCode() {
  for (let i = 0; i < 10; i += 1) {
    const code = generateInviteCode();
    if (!(await Group.exists({ inviteCode: code }))) return code;
  }
  throw new Error('Could not allocate an invite code');
}

/** Normalises "TBT-ABC123", links (…/join/ABC123) and lowercase input to the bare code. */
function normaliseInviteCode(input) {
  const s = String(input || '').trim();
  const fromLink = s.match(/(?:join|invite)[/=]([A-Za-z0-9-]+)/);
  return (fromLink ? fromLink[1] : s).replace(/^TBT-/i, '').toUpperCase();
}

/**
 * Loads a group the user belongs to. `coordinator: true` additionally requires the coordinator
 * role; admins pass every check.
 */
async function loadGroupForUser(groupId, user, { coordinator = false } = {}) {
  if (!/^[a-f0-9]{24}$/i.test(String(groupId))) throw err('NOT_FOUND', 'Group not found.');
  const group = await Group.findById(groupId);
  if (!group) throw err('NOT_FOUND', 'Group not found.');
  const membership = await Membership.findOne({ groupId: group._id, userId: user._id, status: 'joined' });
  if (!membership && !user.isAdmin) throw err('ACCESS_DENIED');
  const isCoordinator = String(group.coordinatorId) === String(user._id);
  if (coordinator && !isCoordinator && !user.isAdmin) {
    throw err('ACCESS_DENIED', 'Only the group coordinator can do this.');
  }
  return { group, membership, isCoordinator };
}

function memberDisplay(m) {
  const u = m.userId && typeof m.userId === 'object' && m.userId.name ? m.userId : null;
  const name = u ? u.name : m.inviteName || m.invitePhone || 'Member';
  return {
    membershipId: String(m._id),
    userId: u ? String(u._id) : m.userId ? String(m.userId) : null,
    name,
    initials: name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(''),
    profilePhotoUrl: u && u.profilePhotoFileId ? `/api/v1/files/${u.profilePhotoFileId}` : null,
    phone: u ? u.phone : m.invitePhone,
    role: m.role,
    status: m.status,
    participant: m.participant,
    payoutPosition: m.payoutPosition || null,
    hasReceivedPayout: m.hasReceivedPayout,
    joinedAt: m.joinedAt || null,
  };
}

async function listMembers(groupId, { includeRemoved = false } = {}) {
  const q = { groupId };
  if (!includeRemoved) q.status = { $ne: 'removed' };
  const ms = await Membership.find(q).populate('userId', 'name phone profilePhotoFileId').sort({ payoutPosition: 1, createdAt: 1 });
  return ms.map(memberDisplay);
}

/** Setup checklist used by the wizard and by activation. */
function setupStatus(group, activeMemberships) {
  const participants = activeMemberships.filter((m) => m.participant);
  const orderSet = new Set(group.payoutOrder.map(String));
  const missing = [];
  if (!group.name) missing.push('name');
  if (!group.contributionAmount) missing.push('contributionAmount');
  if (!group.cycleFrequency) missing.push('cycleFrequency');
  if (!group.firstDueDate) missing.push('firstDueDate');
  if (!group.memberCount) missing.push('memberCount');
  if (group.memberCount && participants.length !== group.memberCount) missing.push('members');
  const orderComplete =
    participants.length > 0 &&
    group.payoutOrder.length === participants.length &&
    participants.every((m) => orderSet.has(String(m._id)));
  if (!orderComplete) missing.push('payoutOrder');
  return {
    steps: {
      basics: Boolean(group.name && group.contributionAmount),
      cycle: Boolean(group.cycleFrequency && group.firstDueDate && group.memberCount),
      members: Boolean(group.memberCount && participants.length === group.memberCount),
      payoutOrder: orderComplete,
    },
    participantsAdded: participants.length,
    missing,
    readyToActivate: missing.length === 0,
  };
}

function groupSummary(group) {
  const json = group.toJSON();
  const fee = group.contributionAmount ? breakdown(group.contributionAmount, group.platformFeeBps) : null;
  return {
    ...json,
    inviteLink: `https://turnbyturn.app/join/${group.inviteCode}`,
    feeNote: `TurnByTurn fee: ${group.platformFeeBps / 100}% added on top`,
    perMemberCharge: fee, // contribution + service fee = what each member pays per cycle
  };
}

async function currentCycle(group) {
  if (group.status === 'draft') return null;
  return Cycle.findOne({ groupId: group._id }).sort({ cycleNumber: -1 });
}

/** Per-member payment roster for a cycle (Who Has Paid / Payment Status). */
async function paymentRoster(cycle) {
  const contributions = await Contribution.find({ cycleId: cycle._id }).populate({
    path: 'membershipId',
    populate: { path: 'userId', select: 'name phone profilePhotoFileId' },
  });
  const rows = contributions.map((c) => {
    const m = c.membershipId;
    return {
      ...memberDisplay(m),
      contributionId: String(c._id),
      amountDue: c.amountDue,
      amountPaid: c.amountPaid,
      outstanding: Math.max(0, c.amountDue - c.amountPaid),
      status: c.status,
      paidAt: c.paidAt || null,
      confirmedAt: c.confirmedAt || null,
      isRecipient: String(m._id) === String(cycle.recipientMembershipId),
    };
  });
  rows.sort((a, b) => (a.payoutPosition || 0) - (b.payoutPosition || 0));
  const paid = rows.filter((r) => r.outstanding === 0);
  return {
    cycle: cycleView(cycle),
    paidCount: paid.length,
    unpaidCount: rows.length - paid.length,
    members: rows,
  };
}

function cycleView(cycle) {
  if (!cycle) return null;
  const j = cycle.toJSON();
  const msLeft = cycle.dueDate.getTime() - Date.now();
  return { ...j, daysUntilDue: Math.ceil(msLeft / 86400000) };
}

/** The member's own position in the rotation (Join preview, Home, Payout Order). */
async function nextRecipient(group) {
  const cycle = await currentCycle(group);
  if (!cycle) return null;
  const m = await Membership.findById(cycle.recipientMembershipId).populate('userId', 'name phone profilePhotoFileId');
  const payout = await Payout.findOne({ cycleId: cycle._id });
  return { ...memberDisplay(m), cycleNumber: cycle.cycleNumber, dueDate: cycle.dueDate, payoutStatus: payout && payout.status };
}

async function userIsActive(userId) {
  return User.exists({ _id: userId, status: 'active' });
}

module.exports = {
  uniqueInviteCode,
  normaliseInviteCode,
  loadGroupForUser,
  memberDisplay,
  listMembers,
  setupStatus,
  groupSummary,
  currentCycle,
  paymentRoster,
  cycleView,
  nextRecipient,
  userIsActive,
};
