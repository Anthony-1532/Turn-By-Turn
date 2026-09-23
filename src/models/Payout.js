'use strict';

const mongoose = require('mongoose');
const { jsonPlugin, noDeletePlugin } = require('./plugins');

const PAYOUT_STATUSES = ['blocked', 'eligible', 'processing', 'sent', 'failed', 'delayed_recovery'];

const payoutSchema = new mongoose.Schema(
  {
    cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle', required: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    recipientMembershipId: { type: mongoose.Schema.Types.ObjectId, ref: 'Membership', required: true },
    recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: PAYOUT_STATUSES, default: 'blocked' },
    expectedAmount: { type: Number, required: true },
    confirmedAmount: { type: Number, default: 0 },
    // Gateway reference of the current transfer attempt; history is kept in `attempts`.
    reference: String,
    destination: {
      bankCode: String,
      bankName: String,
      accountNumber: String,
      accountName: String,
    },
    attempts: [
      {
        _id: false,
        reference: String,
        status: String,
        startedAt: Date,
        finishedAt: Date,
        failureReason: String,
        startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      },
    ],
    eligibleAt: Date,
    processingAt: Date,
    sentAt: Date,
    failedAt: Date,
    failureReason: String,
  },
  { timestamps: true },
);

payoutSchema.index({ cycleId: 1 }, { unique: true });
payoutSchema.index({ status: 1, updatedAt: 1 });
payoutSchema.index({ recipientUserId: 1, createdAt: -1 });
payoutSchema.index({ reference: 1 }, { sparse: true });

payoutSchema.virtual('outstandingAmount').get(function outstanding() {
  return Math.max(0, this.expectedAmount - this.confirmedAmount);
});

noDeletePlugin(payoutSchema);
jsonPlugin(payoutSchema);

module.exports = mongoose.model('Payout', payoutSchema);
module.exports.PAYOUT_STATUSES = PAYOUT_STATUSES;
