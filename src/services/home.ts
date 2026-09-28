/** Home → Savings Overview: everything the card needs, computed server-side in one place. */

import type { Types } from 'mongoose';
import { config } from '../config/env';
import {
  Contribution, Cycle, Payout,
  type GroupDoc, type MembershipDoc, type PayoutDoc, type UserDoc,
} from '../models';
import { cycleDueDate } from '../utils/dates';
import type { Kobo } from '../utils/money';
import * as G from './groups';

/**
 * State of the next-payout card, in the order the card should prefer them:
 *   eligible          – it is the user's turn and the pot is ready: show the Payout button
 *   processing        – transfer started, waiting for the bank
 *   failed            – transfer failed; support will retry
 *   delayed_recovery  – a failed transfer is being retried
 *   sent              – paid out recently (within HOME_SENT_PAYOUT_VISIBLE_DAYS)
 *   blocked           – it is the user's turn but members still owe for this cycle
 *   upcoming          – the user's turn is in a future cycle
 */
export type HomePayoutState = 'eligible' | 'processing' | 'failed' | 'delayed_recovery' | 'sent' | 'blocked' | 'upcoming';

const RANK: Record<HomePayoutState, number> = {
  eligible: 0,
  processing: 1,
  failed: 1,
  delayed_recovery: 1,
  sent: 2,
  blocked: 3,
  upcoming: 4,
};

export interface NextPayout {
  state: HomePayoutState;
  /** null while the payout is `upcoming` (the cycle hasn't opened yet). */
  payoutId: string | null;
  groupId: string;
  groupName: string;
  /** The user's slot in the turn order; equals the cycle number of their payout. */
  position: number;
  /** Confirmed amount once collected; the expected pot before that. */
  amount: Kobo;
  /** For blocked: collected so far towards this cycle's pot. */
  collected: Kobo | null;
  /** Cycle due date (blocked/eligible/…) or the scheduled date of a future turn (upcoming). */
  expectedDate: Date | null;
  /** Upcoming only: number of cycles until the user's turn (1 = next cycle). */
  cyclesAway: number | null;
  sentAt: Date | null;
  reference: string | null;
  failureReason: string | null;
  /** True for `eligible`: the Payout button can be shown (POST /payouts/:id/start). */
  canStart: boolean;
  /** False when the user has no verified payout account; starting would fail with PAYOUT_ACCOUNT_MISSING. */
  bankAccountReady: boolean;
}

export interface CycleProgressSummary {
  /** Across every active group the user contributes to, for each group's current cycle. */
  amountDue: Kobo;
  amountPaid: Kobo;
  outstanding: Kobo;
  percentPaid: number;
  status: 'none' | 'unpaid' | 'partial' | 'paid';
  /** Earliest due date among current cycles that still have something to pay. */
  nextDueDate: Date | null;
  groupCount: number;
}

export interface SavingsOverview {
  /** All confirmed contribution principal the user has paid, across all groups (fees excluded). */
  totalConfirmedContributions: Kobo;
  totalServiceFeesPaid: Kobo;
  totalPayoutsReceived: Kobo;
  payoutsReceivedCount: number;
  currentCycle: CycleProgressSummary;
  nextPayout: NextPayout | null;
}

interface Candidate {
  payout: NextPayout;
  sortKey: number;
}

export async function savingsOverview(
  user: UserDoc,
  memberships: MembershipDoc[],
  groupsById: Map<string, GroupDoc>,
  now: Date = new Date(),
): Promise<SavingsOverview> {
  const userId: Types.ObjectId = user._id;

  // ---- lifetime totals
  const [contribAgg, payoutAgg] = await Promise.all([
    Contribution.aggregate<{ paid: number; fees: number }>([
      { $match: { userId } },
      { $group: { _id: null, paid: { $sum: '$amountPaid' }, fees: { $sum: '$serviceFeePaid' } } },
    ]),
    Payout.aggregate<{ total: number; count: number }>([
      { $match: { recipientUserId: userId, status: 'sent' } },
      { $group: { _id: null, total: { $sum: '$confirmedAmount' }, count: { $sum: 1 } } },
    ]),
  ]);

  // ---- current cycle progress
  const progress: CycleProgressSummary = {
    amountDue: 0, amountPaid: 0, outstanding: 0, percentPaid: 0, status: 'none', nextDueDate: null, groupCount: 0,
  };
  for (const m of memberships) {
    const group = groupsById.get(String(m.groupId));
    if (!group || group.status !== 'active' || !m.participant) continue;
    const cycle = await G.currentCycle(group);
    if (!cycle) continue;
    const c = await Contribution.findOne({ cycleId: cycle._id, membershipId: m._id });
    if (!c) continue;
    const outstanding = Math.max(0, c.amountDue - c.amountPaid);
    progress.groupCount += 1;
    progress.amountDue += c.amountDue;
    progress.amountPaid += Math.min(c.amountPaid, c.amountDue);
    progress.outstanding += outstanding;
    if (outstanding > 0 && (!progress.nextDueDate || cycle.dueDate < progress.nextDueDate)) progress.nextDueDate = cycle.dueDate;
  }
  if (progress.groupCount) {
    progress.percentPaid = progress.amountDue ? Math.round((progress.amountPaid / progress.amountDue) * 1000) / 10 : 0;
    progress.status = progress.outstanding === 0 ? 'paid' : progress.amountPaid > 0 ? 'partial' : 'unpaid';
  }

  // ---- next payout
  const bankAccountReady = Boolean(user.bankAccount?.verified);
  const sentCutoff = now.getTime() - config.home.sentPayoutVisibleDays * 86400000;
  const payouts = await Payout.find({ recipientMembershipId: { $in: memberships.map((m) => m._id) } });
  const cycles = await Cycle.find({ _id: { $in: payouts.map((p) => p.cycleId) } });
  const cycleById = new Map(cycles.map((c) => [String(c._id), c]));
  const membershipsWithPayout = new Set(payouts.map((p) => String(p.recipientMembershipId)));

  const candidates: Candidate[] = [];
  const base = (group: GroupDoc, position: number) => ({
    groupId: String(group._id),
    groupName: group.name,
    position,
    bankAccountReady,
  });

  for (const p of payouts) {
    const group = groupsById.get(String(p.groupId));
    const cycle = cycleById.get(String(p.cycleId));
    if (!group || !cycle) continue;
    const state = homeStateFor(p);
    if (state === 'sent' && (!p.sentAt || p.sentAt.getTime() < sentCutoff)) continue;
    const sortKey =
      state === 'sent' ? -(p.sentAt?.getTime() ?? 0) : cycle.dueDate.getTime(); // newest sent first; otherwise soonest
    candidates.push({
      sortKey,
      payout: {
        ...base(group, cycle.cycleNumber),
        state,
        payoutId: String(p._id),
        amount: p.status === 'blocked' ? p.expectedAmount : p.confirmedAmount,
        collected: p.status === 'blocked' ? cycle.confirmedReceived : null,
        expectedDate: cycle.dueDate,
        cyclesAway: null,
        sentAt: p.sentAt ?? null,
        reference: p.reference ?? null,
        failureReason: state === 'failed' || state === 'delayed_recovery' ? (p.failureReason ?? null) : null,
        canStart: state === 'eligible',
      },
    });
  }

  // Turns whose cycle hasn't opened yet.
  for (const m of memberships) {
    const group = groupsById.get(String(m.groupId));
    if (!group || group.status !== 'active' || !m.participant || m.hasReceivedPayout) continue;
    if (membershipsWithPayout.has(String(m._id)) || !m.payoutPosition) continue;
    if (!group.firstDueDate || !group.cycleFrequency || !group.contributionAmount) continue;
    const expectedDate = cycleDueDate(group.firstDueDate, group.cycleFrequency, m.payoutPosition);
    candidates.push({
      sortKey: expectedDate.getTime(),
      payout: {
        ...base(group, m.payoutPosition),
        state: 'upcoming',
        payoutId: null,
        amount: group.contributionAmount * group.payoutOrder.length,
        collected: null,
        expectedDate,
        cyclesAway: Math.max(1, m.payoutPosition - group.currentCycleNumber),
        sentAt: null,
        reference: null,
        failureReason: null,
        canStart: false,
      },
    });
  }

  candidates.sort((a, b) => RANK[a.payout.state] - RANK[b.payout.state] || a.sortKey - b.sortKey);

  return {
    totalConfirmedContributions: contribAgg[0]?.paid ?? 0,
    totalServiceFeesPaid: contribAgg[0]?.fees ?? 0,
    totalPayoutsReceived: payoutAgg[0]?.total ?? 0,
    payoutsReceivedCount: payoutAgg[0]?.count ?? 0,
    currentCycle: progress,
    nextPayout: candidates[0]?.payout ?? null,
  };
}

function homeStateFor(p: PayoutDoc): HomePayoutState {
  return p.status; // PayoutStatus values are a subset of HomePayoutState
}
