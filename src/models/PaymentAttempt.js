'use strict';

const mongoose = require('mongoose');
const { jsonPlugin, noDeletePlugin } = require('./plugins');

/**
 * One checkout session with the gateway (a full or partial payment towards a Contribution).
 * `reference` is the TRX-MMDD-#### reference shown on receipts and used as the gateway
 * transaction_ref, which makes it the idempotency key for webhook processing.
 */
const paymentAttemptSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true },
    contributionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contribution', required: true },
    cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle', required: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['full', 'partial'], required: true },
    amount: { type: Number, required: true }, // principal, kobo
    serviceFee: { type: Number, required: true },
    totalCharged: { type: Number, required: true },
    // pending → processing (claimed by a webhook/verify) → success | failed | abandoned
    status: {
      type: String,
      enum: ['pending', 'processing', 'success', 'failed', 'abandoned'],
      default: 'pending',
    },
    checkoutUrl: String,
    gatewayReference: String,
    gatewayAmountReceived: Number, // what the gateway says it actually collected
    amountCredited: Number, // principal applied to the contribution
    excessAmount: { type: Number, default: 0 },
    channel: String,
    confirmedAt: Date,
    failureReason: String,
  },
  { timestamps: true },
);

paymentAttemptSchema.index({ reference: 1 }, { unique: true });
paymentAttemptSchema.index({ contributionId: 1, createdAt: -1 });
paymentAttemptSchema.index({ userId: 1, createdAt: -1 });
paymentAttemptSchema.index({ status: 1, createdAt: 1 });

noDeletePlugin(paymentAttemptSchema);
jsonPlugin(paymentAttemptSchema);

module.exports = mongoose.model('PaymentAttempt', paymentAttemptSchema);
