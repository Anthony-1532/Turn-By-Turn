import crypto from 'crypto';
import type { Types } from 'mongoose';
import {
  Group, Membership, Cycle, Contribution, Payout,
  type GroupDoc, type MembershipDoc, type CycleDoc, type UserDoc, type MembershipRole, type MembershipStatus,
  type ContributionStatus, type PayoutStatus,
  initialsOf, toJson, type Json,
} from '../models';
import { err } from '../utils/errors';
import { breakdown, type FeeBreakdown, type Kobo } from '../utils/money';
import { isObjectId } from '../utils/validators';

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

function generateInviteCode(len = 6): string {
  let s = '';
  for (let i = 0; i < len; i += 1) s += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  return s;
}

export async function uniqueInviteCode(): Promise<string> {
  for (let i = 0; i < 10; i += 1) {
    const code = generateInviteCode();
    if (!(await Group.exists({ inviteCode: code }))) return code;
  }
  throw new Error('Could not allocate an invite code');
}

/** Normalises "TBT-ABC123", links (…/join/ABC123) and lowercase input to the bare code. */
export function normaliseInviteCode(input: string): string {
  const s = String(input ?? '').trim();
  const fromLink = s.match(/(?:join|invite)[/=]([A-Za-z0-9-]+)/);
  return (fromLink?.[1] ?? s).replace(/^TBT-/i, '').toUpperCase();
}

export const inviteLink = (code: string): string => `https://turnbyturn.app/join/${code}`;

export interface GroupAccess {
  group: GroupDoc;
  membership: MembershipDoc | null;
  isCoordinator: boolean;
}

/**
 * Loads a group the user belongs to. `coordinator: true` additionally requires the coordinator
 * role; admins pass every check.
 */
export async function loadGroupForUser(
  groupId: string | Types.ObjectId,
  user: UserDoc,
  { coordinator = false }: { coordinator?: boolean } = {},
): Promise<GroupAccess> {
  if (!isObjectId(String(groupId))) throw err('NOT_FOUND', 'Group not found.');
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

// ------------------------------------------------------------------ Member view

export interface PopulatedUserLite {
  _id: Types.ObjectId;
  name: string;
  phone: string;
  profilePhotoFileId?: Types.ObjectId | null;
}

export const MEMBER_USER_FIELDS = 'name phone profilePhotoFileId';

/** A membership whose userId may or may not have been populated. */
export interface MembershipLike {
  _id: Types.ObjectId;
  userId?: Types.ObjectId | PopulatedUserLite | null;
  role: MembershipRole;
  status: MembershipStatus;
  participant: boolean;
  inviteName?: string | null;
  invitePhone?: string | null;
  payoutPosition?: number | null;
  hasReceivedPayout: boolean;
  joinedAt?: Date | null;
}

export interface MemberView {
  membershipId: string;
  userId: string | null;
  name: string;
  initials: string;
  profilePhotoUrl: string | null;
  phone: string | null;
  role: MembershipRole;
  status: MembershipStatus;
  participant: boolean;
  payoutPosition: number | null;
  hasReceivedPayout: boolean;
  joinedAt: Date | null;
}

const isPopulatedUser = (u: MembershipLike['userId']): u is PopulatedUserLite =>
  typeof u === 'object' && u !== null && 'name' in u;

export function memberDisplay(m: MembershipLike): MemberView {
  const u = isPopulatedUser(m.userId) ? m.userId : null;
  const name = u ? u.name : m.inviteName || m.invitePhone || 'Member';
  const rawUserId = u ? u._id : m.userId;
  return {
    membershipId: String(m._id),
    userId: rawUserId ? String(rawUserId) : null,
    name,
    initials: initialsOf(name),
    profilePhotoUrl: u?.profilePhotoFileId ? `/api/v1/files/${u.profilePhotoFileId}` : null,
    phone: u ? u.phone : (m.invitePhone ?? null),
    role: m.role,
    status: m.status,
    participant: m.participant,
    payoutPosition: m.payoutPosition ?? null,
    hasReceivedPayout: m.hasReceivedPayout,
    joinedAt: m.joinedAt ?? null,
  };
}

export async function listMembers(groupId: Types.ObjectId, { includeRemoved = false } = {}): Promise<MemberView[]> {
  const q = includeRemoved ? { groupId } : { groupId, status: { $ne: 'removed' as const } };
  const ms = await Membership.find(q)
    .populate<{ userId: PopulatedUserLite | null }>('userId', MEMBER_USER_FIELDS)
    .sort({ payoutPosition: 1, createdAt: 1 });
  return ms.map(memberDisplay);
}

// ------------------------------------------------------------------ Setup / summaries

export interface SetupStatus {
  steps: { basics: boolean; cycle: boolean; members: boolean; payoutOrder: boolean };
  participantsAdded: number;
  missing: string[];
  readyToActivate: boolean;
}

/** Setup checklist used by the wizard and by activation. */
export function setupStatus(group: GroupDoc, activeMemberships: MembershipDoc[]): SetupStatus {
  const participants = activeMemberships.filter((m) => m.participant);
  const orderSet = new Set(group.payoutOrder.map(String));
  const missing: string[] = [];
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

export type GroupSummary = Json<GroupDoc> & {
  inviteLink: string;
  feeNote: string;
  perMemberCharge: FeeBreakdown | null;
};

export function groupSummary(group: GroupDoc): GroupSummary {
  return {
    ...toJson(group),
    inviteLink: inviteLink(group.inviteCode),
    feeNote: `TurnByTurn fee: ${group.platformFeeBps / 100}% added on top`,
    perMemberCharge: group.contributionAmount ? breakdown(group.contributionAmount, group.platformFeeBps) : null,
  };
}

export async function currentCycle(group: GroupDoc): Promise<CycleDoc | null> {
  if (group.status === 'draft') return null;
  return Cycle.findOne({ groupId: group._id }).sort({ cycleNumber: -1 });
}

export type CycleView = Json<CycleDoc> & { daysUntilDue: number };

export function cycleView(cycle: CycleDoc | null): CycleView | null {
  if (!cycle) return null;
  const msLeft = cycle.dueDate.getTime() - Date.now();
  return { ...toJson(cycle), daysUntilDue: Math.ceil(msLeft / 86400000) };
}

/** `status` is the contribution status; the membership status moves to `memberStatus`. */
export interface RosterRow extends Omit<MemberView, 'status'> {
  memberStatus: MembershipStatus;
  contributionId: string;
  amountDue: Kobo;
  amountPaid: Kobo;
  outstanding: Kobo;
  status: ContributionStatus;
  paidAt: Date | null;
  confirmedAt: Date | null;
  isRecipient: boolean;
}

export interface PaymentRoster {
  cycle: CycleView | null;
  paidCount: number;
  unpaidCount: number;
  members: RosterRow[];
}

/** Per-member payment roster for a cycle (Who Has Paid / Payment Status). */
export async function paymentRoster(cycle: CycleDoc): Promise<PaymentRoster> {
  const contributions = await Contribution.find({ cycleId: cycle._id }).populate<{ membershipId: MembershipLike }>({
    path: 'membershipId',
    populate: { path: 'userId', select: MEMBER_USER_FIELDS },
  });
  const rows: RosterRow[] = contributions.map((c) => {
    const m = c.membershipId;
    const { status: memberStatus, ...member } = memberDisplay(m);
    return {
      ...member,
      memberStatus,
      contributionId: String(c._id),
      amountDue: c.amountDue,
      amountPaid: c.amountPaid,
      outstanding: Math.max(0, c.amountDue - c.amountPaid),
      status: c.status,
      paidAt: c.paidAt ?? null,
      confirmedAt: c.confirmedAt ?? null,
      isRecipient: String(m._id) === String(cycle.recipientMembershipId),
    };
  });
  rows.sort((a, b) => (a.payoutPosition ?? 0) - (b.payoutPosition ?? 0));
  const paid = rows.filter((r) => r.outstanding === 0);
  return { cycle: cycleView(cycle), paidCount: paid.length, unpaidCount: rows.length - paid.length, members: rows };
}

export interface NextRecipient extends MemberView {
  cycleNumber: number;
  dueDate: Date;
  payoutStatus: PayoutStatus | null;
}

/** Whose turn it is in the current cycle. */
export async function nextRecipient(group: GroupDoc): Promise<NextRecipient | null> {
  const cycle = await currentCycle(group);
  if (!cycle) return null;
  const m = await Membership.findById(cycle.recipientMembershipId).populate<{ userId: PopulatedUserLite | null }>(
    'userId',
    MEMBER_USER_FIELDS,
  );
  if (!m) return null;
  const payout = await Payout.findOne({ cycleId: cycle._id });
  return { ...memberDisplay(m), cycleNumber: cycle.cycleNumber, dueDate: cycle.dueDate, payoutStatus: payout?.status ?? null };
}
