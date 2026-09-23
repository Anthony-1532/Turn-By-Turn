'use strict';

const mongoose = require('mongoose');
const { jsonPlugin } = require('./plugins');

const bankAccountSchema = new mongoose.Schema(
  {
    bankCode: { type: String, required: true },
    bankName: { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true },
    verified: { type: Boolean, default: false },
    nameMatch: { type: Boolean, default: false },
    verifiedAt: Date,
  },
  { _id: false },
);

const notificationPreferencesSchema = new mongoose.Schema(
  {
    push: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
    sms: { type: Boolean, default: false },
    paymentReminders: { type: Boolean, default: true },
    groupActivity: { type: Boolean, default: true },
    announcements: { type: Boolean, default: true },
    payoutUpdates: { type: Boolean, default: true },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true }, // E.164, e.g. +2348012345678
    email: { type: String, required: true, trim: true, lowercase: true },
    passwordHash: { type: String },
    phoneVerifiedAt: Date,
    // pending_verification → pending_password → active
    status: {
      type: String,
      enum: ['pending_verification', 'pending_password', 'active', 'suspended'],
      default: 'pending_verification',
    },
    isAdmin: { type: Boolean, default: false },

    profilePhotoFileId: { type: mongoose.Schema.Types.ObjectId },
    income: {
      fixedIncome: { type: Number, min: 0 }, // kobo per month
      variableIncome: { type: Number, min: 0 },
    },
    bankAccount: bankAccountSchema,
    trustedContact: {
      name: String,
      phone: String,
      relationship: String,
      skipped: { type: Boolean, default: false },
    },
    notificationPreferences: { type: notificationPreferencesSchema, default: () => ({}) },
    deviceTokens: [
      {
        _id: false,
        token: { type: String, required: true },
        platform: { type: String, enum: ['android', 'ios', 'web'], default: 'android' },
        updatedAt: { type: Date, default: Date.now },
      },
    ],
    lastLoginAt: Date,
    passwordChangedAt: Date,
  },
  { timestamps: true },
);

// Uniqueness is only enforced among completed accounts: an abandoned sign-up must not block
// someone from retrying (or "change number") with the same details.
// (passwordHash is only set once sign-up completes.)
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { passwordHash: { $exists: true } } });
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { passwordHash: { $exists: true } } });
userSchema.index({ 'deviceTokens.token': 1 });
userSchema.index({ phone: 1, status: 1 });
userSchema.index({ email: 1, status: 1 });

userSchema.virtual('profilePhotoUrl').get(function photoUrl() {
  return this.profilePhotoFileId ? `/api/v1/files/${this.profilePhotoFileId}` : null;
});

userSchema.virtual('initials').get(function initials() {
  return (this.name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
});

jsonPlugin(userSchema, { hidden: ['passwordHash', 'deviceTokens', 'profilePhotoFileId', 'passwordChangedAt'] });

module.exports = mongoose.model('User', userSchema);
