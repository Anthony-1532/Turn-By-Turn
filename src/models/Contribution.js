'use strict';

const mongoose = require('mongoose');
const { jsonPlugin, noDeletePlugin } = require('./plugins');

/**
 * A member's obligation for one cycle. Individual gateway payments towards it are
 * PaymentAttempts; amountPaid is the sum of confirmed principal (fees excluded).
 */
const contributionSchema = new mongoose.Schema(
  {
    cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle', required: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    membershipId: { type: mongoose.Schema.Types.ObjectId, ref: 'Membership', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // null while an invite is unclaimed
    amountDue: { type: Number, required: true }, // kobo
    amountPaid: { type: Number, default: 0 },
    serviceFeePaid: { type: Number, default: 0 },
    totalCharged: { type: Number, default: 0 },
    // Money the gateway confirmed beyond what was required; held for manual review.
    excessAmount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['unpaid', 'partial', 'paid', 'reconciliation_required', 'under_review'],
      default: 'unpaid',
    },
    lastPaymentReference: String,
    paidAt: Date, // first payment
    confirmedAt: Date, // fully paid
  },
  { timestamps: true },
);

contributionSchema.index({ cycleId: 1, membershipId: 1 }, { unique: true });
contributionSchema.index({ userId: 1, createdAt: -1 });
contributionSchema.index({ groupId: 1, status: 1 });

contributionSchema.virtual('outstandingAmount').get(function outstanding() {
  return Math.max(0, this.amountDue - this.amountPaid);
});

noDeletePlugin(contributionSchema);
jsonPlugin(contributionSchema);

module.exports = mongoose.model('Contribution', contributionSchema);
