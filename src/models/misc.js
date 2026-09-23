'use strict';

/** Smaller collections that don't warrant a file each. */

const mongoose = require('mongoose');
const { jsonPlugin } = require('./plugins');

const { ObjectId } = mongoose.Schema.Types;

// ---------------------------------------------------------------------------- Announcement
const announcementSchema = new mongoose.Schema(
  {
    groupId: { type: ObjectId, ref: 'Group', required: true },
    authorId: { type: ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);
announcementSchema.index({ groupId: 1, createdAt: -1 });
jsonPlugin(announcementSchema);

// ---------------------------------------------------------------------------- ActivityLog
const activitySchema = new mongoose.Schema(
  {
    groupId: { type: ObjectId, ref: 'Group', required: true },
    actorId: { type: ObjectId, ref: 'User' }, // null for system events
    eventType: { type: String, required: true },
    summary: { type: String, required: true },
    data: mongoose.Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
activitySchema.index({ groupId: 1, createdAt: -1 });
jsonPlugin(activitySchema);

// ---------------------------------------------------------------------------- Notification
const notificationSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    groupId: { type: ObjectId, ref: 'Group' },
    data: mongoose.Schema.Types.Mixed,
    read: { type: Boolean, default: false },
    readAt: Date,
  },
  { timestamps: true },
);
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, read: 1 });
jsonPlugin(notificationSchema);

// ---------------------------------------------------------------------------- Reminder
const reminderSchema = new mongoose.Schema(
  {
    groupId: { type: ObjectId, ref: 'Group', required: true },
    cycleId: { type: ObjectId, ref: 'Cycle' },
    sentBy: { type: ObjectId, ref: 'User' }, // null for scheduled reminders
    kind: { type: String, enum: ['manual', 'auto'], default: 'manual' },
    autoKey: String, // e.g. "d3" for "3 days before due" — makes scheduled reminders idempotent
    channels: [{ type: String, enum: ['push', 'sms', 'email', 'in_app'] }],
    targetMembershipIds: [{ type: ObjectId, ref: 'Membership' }],
    message: String,
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);
reminderSchema.index({ groupId: 1, sentAt: -1 });
reminderSchema.index({ targetMembershipIds: 1, sentAt: -1 });
reminderSchema.index(
  { cycleId: 1, autoKey: 1 },
  { unique: true, partialFilterExpression: { kind: 'auto' } },
);
jsonPlugin(reminderSchema);

// ---------------------------------------------------------------------------- SupportTicket
/** Manual, human-in-the-loop escalations (Resolution Required, Reconciliation Required, help). */
const supportTicketSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['cycle_resolution', 'reconciliation', 'payout', 'general'], required: true },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    userId: { type: ObjectId, ref: 'User', required: true },
    groupId: { type: ObjectId, ref: 'Group' },
    cycleId: { type: ObjectId, ref: 'Cycle' },
    contributionId: { type: ObjectId, ref: 'Contribution' },
    payoutId: { type: ObjectId, ref: 'Payout' },
    paymentReference: String,
    message: String,
    resolution: {
      action: String,
      note: String,
      resolvedBy: { type: ObjectId, ref: 'User' },
      resolvedAt: Date,
    },
  },
  { timestamps: true },
);
supportTicketSchema.index({ status: 1, kind: 1, createdAt: -1 });
supportTicketSchema.index({ userId: 1, createdAt: -1 });
jsonPlugin(supportTicketSchema);

// ---------------------------------------------------------------------------- Otp
const otpSchema = new mongoose.Schema(
  {
    target: { type: String, required: true }, // phone or email
    purpose: { type: String, enum: ['signup', 'reset_password'], required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, default: Date.now },
    consumedAt: Date,
  },
  { timestamps: true },
);
otpSchema.index({ target: 1, purpose: 1 }, { unique: true });
// Documents disappear a day after expiry.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

// ---------------------------------------------------------------------------- RefreshToken
const refreshTokenSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    family: { type: String, required: true }, // rotation chain; reuse of a rotated token revokes the family
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    replacedBy: String,
    userAgent: String,
    ip: String,
  },
  { timestamps: true },
);
refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ userId: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ---------------------------------------------------------------------------- RateLimit
/** Server-side throttling state (sign-in lockout, OTP sends). Shared across instances. */
const rateLimitSchema = new mongoose.Schema({
  key: { type: String, required: true },
  count: { type: Number, default: 0 },
  windowStart: { type: Date, default: Date.now },
  lockedUntil: Date,
  expiresAt: { type: Date, required: true },
});
rateLimitSchema.index({ key: 1 }, { unique: true });
rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ---------------------------------------------------------------------------- Counter
/** Atomic daily sequences for TRX-MMDD-#### references. */
const counterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 },
});

// ---------------------------------------------------------------------------- WebhookEvent
/** Idempotency log of processed gateway callbacks. */
const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true },
    key: { type: String, required: true },
    event: String,
    payload: mongoose.Schema.Types.Mixed,
    status: { type: String, enum: ['received', 'processed', 'ignored', 'error'], default: 'received' },
    error: String,
  },
  { timestamps: true },
);
webhookEventSchema.index({ provider: 1, key: 1 }, { unique: true });

module.exports = {
  Announcement: mongoose.model('Announcement', announcementSchema),
  ActivityLog: mongoose.model('ActivityLog', activitySchema),
  Notification: mongoose.model('Notification', notificationSchema),
  Reminder: mongoose.model('Reminder', reminderSchema),
  SupportTicket: mongoose.model('SupportTicket', supportTicketSchema),
  Otp: mongoose.model('Otp', otpSchema),
  RefreshToken: mongoose.model('RefreshToken', refreshTokenSchema),
  RateLimit: mongoose.model('RateLimit', rateLimitSchema),
  Counter: mongoose.model('Counter', counterSchema),
  WebhookEvent: mongoose.model('WebhookEvent', webhookEventSchema),
};
