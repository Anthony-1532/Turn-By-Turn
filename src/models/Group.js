'use strict';

const mongoose = require('mongoose');
const { jsonPlugin } = require('./plugins');
const { FREQUENCIES } = require('../utils/dates');

const groupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    coordinatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Whether the coordinator also contributes and takes a turn (the common ajo arrangement).
    coordinatorParticipates: { type: Boolean, default: true },

    contributionAmount: { type: Number, min: 0 }, // kobo, per member per cycle
    memberCount: { type: Number, min: 2, max: 100 },
    cycleFrequency: { type: String, enum: FREQUENCIES },
    firstDueDate: Date,
    platformFeeBps: { type: Number, default: 200 },

    // Ordered Membership ids; index 0 receives the first payout. Locked on activation.
    payoutOrder: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Membership' }],

    status: { type: String, enum: ['draft', 'active', 'completed'], default: 'draft' },
    activatedAt: Date,
    completedAt: Date,
    currentCycleNumber: { type: Number, default: 0 },

    inviteCode: { type: String, required: true },
    rules: [{ type: String, trim: true }],
  },
  { timestamps: true },
);

groupSchema.index({ inviteCode: 1 }, { unique: true });
groupSchema.index({ coordinatorId: 1, status: 1 });
groupSchema.index({ status: 1 });

groupSchema.virtual('expectedCycleTotal').get(function expected() {
  if (!this.contributionAmount || !this.memberCount) return null;
  return this.contributionAmount * this.memberCount;
});

groupSchema.virtual('platformFeePercent').get(function pct() {
  return this.platformFeeBps / 100;
});

groupSchema.virtual('isLocked').get(function locked() {
  return this.status !== 'draft';
});

jsonPlugin(groupSchema);

module.exports = mongoose.model('Group', groupSchema);
