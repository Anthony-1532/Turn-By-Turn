'use strict';

/** Home, universal history, notifications, support. */

const express = require('express');
const mongoose = require('mongoose');
const {
  Membership, Group, Contribution, Transaction, Notification, SupportTicket, PaymentAttempt, Payout,
} = require('../models');
const { TRANSACTION_TYPES, TRANSACTION_STATUSES } = require('../models/Transaction');
const { h, auth, validate } = require('../middleware');
const { err } = require('../utils/errors');
const v = require('../utils/validators');
const { monthKey, monthLabel, monthRange } = require('../utils/dates');
const G = require('../services/groups');
const payments = require('../services/payments');
const payoutsSvc = require('../services/payouts');

const router = express.Router();
const { z } = v;

router.use(auth);

// ------------------------------------------------------------------ Home

/** Member Home / Returning Home: cross-group overview. */
router.get(
  '/home',
  h(async (req, res) => {
    const memberships = await Membership.find({ userId: req.user._id, status: 'joined' });
    const groups = await Group.find({ _id: { $in: memberships.map((m) => m.groupId) } });
    const byId = new Map(groups.map((g) => [String(g._id), g]));
    const cards = [];
    let totalDue = 0;
    for (const m of memberships) {
      const g = byId.get(String(m.groupId));
      if (!g) continue;
      const cycle = await G.currentCycle(g);
      const c = cycle && (await Contribution.findOne({ cycleId: cycle._id, membershipId: m._id }));
      const outstanding = c ? c.outstandingAmount : 0;
      if (cycle && cycle.status !== 'complete') totalDue += outstanding;
      cards.push({
        groupId: String(g._id),
        name: g.name,
        status: g.status,
        role: m.role,
        payoutPosition: m.payoutPosition || null,
        hasReceivedPayout: m.hasReceivedPayout,
        contributionAmount: g.contributionAmount,
        currentCycle: G.cycleView(cycle),
        myContribution: c ? { id: String(c._id), amountDue: c.amountDue, amountPaid: c.amountPaid, outstanding, status: c.status } : null,
        nextRecipient: await G.nextRecipient(g),
      });
    }
    // Due soonest first; drafts last.
    cards.sort((a, b) => {
      const da = a.currentCycle ? new Date(a.currentCycle.dueDate).getTime() : Infinity;
      const db = b.currentCycle ? new Date(b.currentCycle.dueDate).getTime() : Infinity;
      return da - db;
    });
    const nextDue = cards.find((c) => c.myContribution && c.myContribution.outstanding > 0) || null;
    const upcomingPayout = await Payout.findOne({
      recipientMembershipId: { $in: memberships.map((m) => m._id) },
      status: { $in: ['blocked', 'eligible', 'processing', 'failed', 'delayed_recovery'] },
    }).sort({ createdAt: 1 });
    res.json({
      user: { id: String(req.user._id), name: req.user.name, initials: req.user.initials, profilePhotoUrl: req.user.profilePhotoUrl },
      summary: {
        groupCount: cards.length,
        coordinatingCount: cards.filter((c) => c.role === 'coordinator').length,
        totalOutstanding: totalDue,
      },
      nextDue,
      upcomingPayout: upcomingPayout ? await payoutsSvc.describePayout(upcomingPayout) : null,
      groups: cards,
      unreadNotifications: await Notification.countDocuments({ userId: req.user._id, read: false }),
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

/** Payment list grouped by month, filterable by period / status / type / group. */
router.get(
  '/transactions',
  validate(historyQuery, 'query'),
  h(async (req, res) => {
    const { month, from, to, status, type, groupId, before, limit } = req.query;
    const q = { userId: req.user._id };
    if (status) q.status = status;
    if (type) q.type = type;
    if (groupId) q.groupId = new mongoose.Types.ObjectId(groupId);
    const created = {};
    if (month) {
      const r = monthRange(month);
      created.$gte = r.start;
      created.$lt = r.end;
    }
    if (from) created.$gte = from;
    if (to) created.$lte = to;
    if (before) created.$lt = before;
    if (Object.keys(created).length) q.createdAt = created;

    const rows = await Transaction.find(q).sort({ createdAt: -1 }).limit(limit);
    const months = [];
    const index = new Map();
    for (const t of rows) {
      const key = monthKey(t.createdAt);
      if (!index.has(key)) {
        index.set(key, months.length);
        months.push({ month: key, label: monthLabel(key), totalOut: 0, totalIn: 0, transactions: [] });
      }
      const bucket = months[index.get(key)];
      bucket.transactions.push(t.toJSON());
      if (t.status === 'success') {
        if (t.direction === 'debit') bucket.totalOut += t.amount;
        else bucket.totalIn += t.amount;
      }
    }
    res.json({ months, count: rows.length, nextBefore: rows.length === limit ? rows[rows.length - 1].createdAt : null });
  }),
);

/** Values for the Filter sheet. */
router.get(
  '/transactions/filters',
  h(async (req, res) => {
    const [monthsAgg, groupIds] = await Promise.all([
      Transaction.aggregate([
        { $match: { userId: req.user._id } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Africa/Lagos' } } } },
        { $sort: { _id: -1 } },
      ]),
      Transaction.distinct('groupId', { userId: req.user._id }),
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
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw err('NOT_FOUND');
    const t = await Transaction.findOne({ _id: req.params.id, userId: req.user._id });
    if (!t) throw err('NOT_FOUND', 'Transaction not found.');
    const related = await Transaction.find({ reference: t.reference, userId: req.user._id, _id: { $ne: t._id } });
    const attempt = t.paymentAttemptId ? await PaymentAttempt.findById(t.paymentAttemptId) : null;
    const payout = t.payoutId ? await Payout.findById(t.payoutId) : null;
    res.json({
      transaction: t.toJSON(),
      related: related.map((r) => r.toJSON()),
      receipt: attempt && attempt.status === 'success' ? await payments.receiptFor(attempt) : null,
      payout: payout ? await payoutsSvc.describePayout(payout) : null,
    });
  }),
);

// ------------------------------------------------------------------ Notifications

router.get(
  '/notifications',
  validate(z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(100).default(30), unreadOnly: z.enum(['true', 'false']).optional() }), 'query'),
  h(async (req, res) => {
    const q = { userId: req.user._id };
    if (req.query.before) q.createdAt = { $lt: req.query.before };
    if (req.query.unreadOnly === 'true') q.read = false;
    const list = await Notification.find(q).sort({ createdAt: -1 }).limit(req.query.limit);
    res.json({
      notifications: list.map((n) => n.toJSON()),
      unreadCount: await Notification.countDocuments({ userId: req.user._id, read: false }),
      nextBefore: list.length === req.query.limit ? list[list.length - 1].createdAt : null,
    });
  }),
);

router.post(
  '/notifications/read',
  validate(z.object({ ids: z.array(v.objectId).optional(), all: z.boolean().optional() })),
  h(async (req, res) => {
    const q = { userId: req.user._id, read: false };
    if (!req.body.all) q._id = { $in: req.body.ids || [] };
    const r = await Notification.updateMany(q, { $set: { read: true, readAt: new Date() } });
    res.json({ updated: r.modifiedCount });
  }),
);

// ------------------------------------------------------------------ Support

router.post(
  '/support/tickets',
  validate(
    z.object({
      kind: z.enum(['general', 'payout', 'cycle_resolution']).default('general'),
      message: z.string().trim().min(5).max(2000),
      groupId: v.objectId.optional(),
      paymentReference: z.string().max(40).optional(),
    }),
  ),
  h(async (req, res) => {
    if (req.body.groupId) await G.loadGroupForUser(req.body.groupId, req.user);
    const ticket = await SupportTicket.create({ ...req.body, userId: req.user._id });
    res.status(201).json({ ticket: ticket.toJSON() });
  }),
);

router.get(
  '/support/tickets',
  h(async (req, res) => {
    const list = await SupportTicket.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50);
    res.json({ tickets: list.map((t) => t.toJSON()) });
  }),
);

module.exports = router;
