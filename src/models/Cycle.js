'use strict';

const mongoose = require('mongoose');
const { jsonPlugin } = require('./plugins');

const cycleSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    cycleNumber: { type: Number, required: true, min: 1 },
    periodLabel: String,
    dueDate: { type: Date, required: true },
    expectedTotal: { type: Number, required: true }, // kobo
    confirmedReceived: { type: Number, default: 0 },
    // open → complete, or open → overdue → resolution_required (→ complete via admin)
    status: {
      type: String,
      enum: ['open', 'complete', 'overdue', 'resolution_required'],
      default: 'open',
    },
    recipientMembershipId: { type: mongoose.Schema.Types.ObjectId, ref: 'Membership', required: true },
    recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    completedAt: Date,
    overdueAt: Date,
    resolutionRequiredAt: Date,
    resolution: {
      resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      resolvedAt: Date,
      action: String,
      note: String,
    },
  },
  { timestamps: true },
);

cycleSchema.index({ groupId: 1, cycleNumber: 1 }, { unique: true });
cycleSchema.index({ status: 1, dueDate: 1 });

cycleSchema.virtual('outstandingAmount').get(function outstanding() {
  return Math.max(0, this.expectedTotal - this.confirmedReceived);
});

cycleSchema.virtual('percentReceived').get(function pct() {
  if (!this.expectedTotal) return 0;
  return Math.min(100, Math.round((this.confirmedReceived / this.expectedTotal) * 1000) / 10);
});

jsonPlugin(cycleSchema);

module.exports = mongoose.model('Cycle', cycleSchema);
