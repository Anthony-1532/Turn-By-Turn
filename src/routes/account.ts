/** Home, universal history, notifications, support. */

import express from 'express';
import mongoose from 'mongoose';
import {
  Membership, Group, Contribution, Transaction, Notification, SupportTicket, PaymentAttempt, Payout,
  TRANSACTION_TYPES, TRANSACTION_STATUSES, toJson, type TransactionDoc, type Json,
} from '../models';
import { h, auth, currentUser, param, parseBody, parseQuery } from '../middleware';
import { err } from '../utils/errors';
import * as v from '../utils/validators';
import { monthKey, monthLabel, monthRange } from '../utils/dates';
import type { Kobo } from '../utils/money';
import * as G from '../services/groups';
import * as payments from '../services/payments';
import * as payoutsSvc from '../services/payouts';

const router = express.Router();
const { z } = v;

router.use(auth);

// ------------------------------------------------------------------ Home

interface HomeGroupCard {
  groupId: string;
  name: string;
  status: string;
  role: string;
  payoutPosition: number | null;
  hasReceivedPayout: boolean;
  contributionAmount: Kobo | null | undefined;
  currentCycle: G.CycleView | null;
  myContribution: { id: string; amountDue: Kobo; amountPaid: Kobo; outstanding: Kobo; status: string } | null;
  nextRecipient: G.NextRecipient | null;
}

/** Member Home / Returning Home: cross-group overview. */
router.get(
  '/home',
  h(async (req, res) => {
    const user = currentUser(req);
    const memberships = await Membership.find({ userId: user._id, status: 'joined' });
    const groups = await Group.find({ _id: { $in: memberships.map((m) => m.groupId) } });
    const byId = new Map(groups.map((g) => [String(g._id), g]));
    const cards: HomeGroupCard[] = [];
    let totalOutstanding: Kobo = 0;
    for (const m of memberships) {
      const g = byId.get(String(m.groupId));
      if (!g) continue;
      const cycle = await G.currentCycle(g);
      const c = cycle ? await Contribution.findOne({ cycleId: cycle._id, membershipId: m._id }) : null;
      const outstanding = c ? c.outstandingAmount : 0;
      if (cycle && cycle.status !== 'complete') totalOutstanding += outstanding;
      cards.push({
        groupId: String(g._id),
        name: g.name,
        status: g.status,
        role: m.role,
        payoutPosition: m.payoutPosition ?? null,
        hasReceivedPayout: m.hasReceivedPayout,
        contributionAmount: g.contributionAmount,
        currentCycle: G.cycleView(cycle),
        myContribution: c ? { id: String(c._id), amountDue: c.amountDue, amountPaid: c.amountPaid, outstanding, status: c.status } : null,
        nextRecipient: await G.nextRecipient(g),
      });
    }
    // Due soonest first; drafts last.
    const dueTime = (card: HomeGroupCard) => (card.currentCycle ? new Date(card.currentCycle.dueDate).getTime() : Infinity);
    cards.sort((a, b) => dueTime(a) - dueTime(b));
    const nextDue = cards.find((c) => c.myContribution && c.myContribution.outstanding > 0) ?? null;
    const upcomingPayout = await Payout.findOne({
      recipientMembershipId: { $in: memberships.map((m) => m._id) },
      status: { $in: ['blocked', 'eligible', 'processing', 'failed', 'delayed_recovery'] },
    }).sort({ createdAt: 1 });
    res.json({
      user: { id: String(user._id), name: user.name, initials: user.initials, profilePhotoUrl: user.profilePhotoUrl },
      summary: {
        groupCount: cards.length,
        coordinatingCount: cards.filter((c) => c.role === 'coordinator').length,
        totalOutstanding,
      },
      nextDue,
      upcomingPayout: upcomingPayout ? await payoutsSvc.describePayout(upcomingPayout) : null,
      groups: cards,
      unreadNotifications: await Notification.countDocuments({ userId: user._id, read: false }),
      quickActions: cards.length ? ['pay', 'join-group', 'create-group', 'history'] : ['join-group', 'create-group'],
    });
  }),
);

// ------------------------------------------------------------------ History (universal ledger)

const historyQuery = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM').optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  groupId: v.objectId.optional(),
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

interface MonthBucket {
  month: string;
  label: string;
  totalOut: Kobo;
  totalIn: Kobo;
  transactions: Array<Json<TransactionDoc>>;
}

/** Payment list grouped by month, filterable by period / status / type / group. */
router.get(
  '/transactions',
  h(async (req, res) => {
    const { month, from, to, status, type, groupId, before, limit } = parseQuery(historyQuery, req);
    const created: { $gte?: Date; $lt?: Date; $lte?: Date } = {};
    if (month) {
      const r = monthRange(month);
      created.$gte = r.start;
      created.$lt = r.end;
    }
    if (from) created.$gte = from;
    if (to) created.$lte = to;
    if (before) created.$lt = before;
    const q = {
      userId: currentUser(req)._id,
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
      ...(groupId ? { groupId: new mongoose.Types.ObjectId(groupId) } : {}),
      ...(Object.keys(created).length ? { createdAt: created } : {}),
    };

    const rows = await Transaction.find(q).sort({ createdAt: -1 }).limit(limit);
    const months: MonthBucket[] = [];
    const index = new Map<string, MonthBucket>();
    for (const t of rows) {
      const key = monthKey(t.createdAt);
      let bucket = index.get(key);
      if (!bucket) {
        bucket = { month: key, label: monthLabel(key), totalOut: 0, totalIn: 0, transactions: [] };
        index.set(key, bucket);
        months.push(bucket);
      }
      bucket.transactions.push(toJson(t));
      if (t.status === 'success') {
        if (t.direction === 'debit') bucket.totalOut += t.amount;
        else bucket.totalIn += t.amount;
      }
    }
    const last = rows[rows.length - 1];
    res.json({ months, count: rows.length, nextBefore: rows.length === limit && last ? last.createdAt : null });
  }),
);

/** Values for the Filter sheet. */
router.get(
  '/transactions/filters',
  h(async (req, res) => {
    const userId = currentUser(req)._id;
    const [monthsAgg, groupIds] = await Promise.all([
      Transaction.aggregate<{ _id: string }>([
        { $match: { userId } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Africa/Lagos' } } } },
        { $sort: { _id: -1 } },
      ]),
      Transaction.distinct('groupId', { userId }),
    ]);
    const groups = await Group.find({ _id: { $in: groupIds } }, 'name');
    res.json({
      periods: monthsAgg.map((m) => ({ month: m._id, label: monthLabel(m._id) })),
      statuses: TRANSACTION_STATUSES,
      types: TRANSACTION_TYPES,
      groups: groups.map((g) => ({ id: String(g._id), name: g.name })),
    });
  }),
);

/** Transaction details (with receipt when it is a contribution). */
router.get(
  '/transactions/:id',
  h(async (req, res) => {
    const userId = currentUser(req)._id;
    const id = param(req, 'id');
    if (!v.isObjectId(id)) throw err('NOT_FOUND');
    const t = await Transaction.findOne({ _id: id, userId });
    if (!t) throw err('NOT_FOUND', 'Transaction not found.');
    const related = await Transaction.find({ reference: t.reference, userId, _id: { $ne: t._id } });
    const attempt = t.paymentAttemptId ? await PaymentAttempt.findById(t.paymentAttemptId) : null;
    const payout = t.payoutId ? await Payout.findById(t.payoutId) : null;
    res.json({
      transaction: toJson(t),
      related: related.map((r) => toJson(r)),
      receipt: attempt?.status === 'success' ? await payments.receiptFor(attempt) : null,
      payout: payout ? await payoutsSvc.describePayout(payout) : null,
    });
  }),
);

// ------------------------------------------------------------------ Notifications

router.get(
  '/notifications',
  h(async (req, res) => {
    const userId = currentUser(req)._id;
    const { before, limit, unreadOnly } = parseQuery(
      z.object({
        before: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        unreadOnly: z.enum(['true', 'false']).optional(),
      }),
      req,
    );
    const list = await Notification.find({
      userId,
      ...(before ? { createdAt: { $lt: before } } : {}),
      ...(unreadOnly === 'true' ? { read: false } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(limit);
    const last = list[list.length - 1];
    res.json({
      notifications: list.map((n) => n.toJSON()),
      unreadCount: await Notification.countDocuments({ userId, read: false }),
      nextBefore: list.length === limit && last ? last.createdAt : null,
    });
  }),
);

router.post(
  '/notifications/read',
  h(async (req, res) => {
    const { ids, all } = parseBody(z.object({ ids: z.array(v.objectId).optional(), all: z.boolean().optional() }), req);
    const r = await Notification.updateMany(
      { userId: currentUser(req)._id, read: false, ...(all ? {} : { _id: { $in: ids ?? [] } }) },
      { $set: { read: true, readAt: new Date() } },
    );
    res.json({ updated: r.modifiedCount });
  }),
);

// ------------------------------------------------------------------ Support

router.post(
  '/support/tickets',
  h(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        kind: z.enum(['general', 'payout', 'cycle_resolution']).default('general'),
        message: z.string().trim().min(5).max(2000),
        groupId: v.objectId.optional(),
        paymentReference: z.string().max(40).optional(),
      }),
      req,
    );
    if (body.groupId) await G.loadGroupForUser(body.groupId, user);
    const ticket = await SupportTicket.create({ ...body, userId: user._id });
    res.status(201).json({ ticket: ticket.toJSON() });
  }),
);

router.get(
  '/support/tickets',
  h(async (req, res) => {
    const list = await SupportTicket.find({ userId: currentUser(req)._id }).sort({ createdAt: -1 }).limit(50);
    res.json({ tickets: list.map((t) => t.toJSON()) });
  }),
);

export default router;
