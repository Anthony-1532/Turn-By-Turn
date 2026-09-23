'use strict';

const mongoose = require('mongoose');
const { jsonPlugin, noDeletePlugin } = require('./plugins');

const TRANSACTION_TYPES = ['contribution', 'fee', 'payout', 'refund', 'adjustment'];
const TRANSACTION_STATUSES = ['pending', 'success', 'failed', 'under_review', 'reversed'];

/**
 * Append-only ledger that powers the universal History screen. Rows are created for every
 * money movement; a row's status may advance (pending → success/failed) but amounts are never
 * rewritten. Corrections are new `adjustment`/`refund` rows linked via `relatedTransactionId`.
 */
const transactionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: TRANSACTION_TYPES, required: true },
    direction: { type: String, enum: ['debit', 'credit'], required: true }, // from the user's view
    amount: { type: Number, required: true, min: 0 }, // kobo
    status: { type: String, enum: TRANSACTION_STATUSES, default: 'pending' },
    reference: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
    cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle' },
    contributionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contribution' },
    paymentAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentAttempt' },
    payoutId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payout' },
    relatedTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    description: String,
    groupName: String, // denormalised for fast history rendering
    meta: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true },
);

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, status: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, type: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, groupId: 1, createdAt: -1 });
transactionSchema.index({ groupId: 1, status: 1 });
transactionSchema.index({ reference: 1, type: 1 }, { unique: true });

noDeletePlugin(transactionSchema);
jsonPlugin(transactionSchema);

module.exports = mongoose.model('Transaction', transactionSchema);
module.exports.TRANSACTION_TYPES = TRANSACTION_TYPES;
module.exports.TRANSACTION_STATUSES = TRANSACTION_STATUSES;
