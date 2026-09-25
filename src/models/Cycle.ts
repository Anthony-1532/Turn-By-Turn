import mongoose, { type HydratedDocumentFromSchema } from 'mongoose';
import { jsonPlugin } from './plugins';

// open → complete, or open → overdue → resolution_required (→ complete via admin)
export const CYCLE_STATUSES = ['open', 'complete', 'overdue', 'resolution_required'] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

const cycleSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    cycleNumber: { type: Number, required: true, min: 1 },
    periodLabel: { type: String, required: true },
    dueDate: { type: Date, required: true },
    expectedTotal: { type: Number, required: true }, // kobo
    confirmedReceived: { type: Number, default: 0, required: true },
    status: { type: String, enum: CYCLE_STATUSES, default: 'open' as CycleStatus, required: true },
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
  {
    timestamps: true,
    virtuals: {
      outstandingAmount: {
        get(this: { expectedTotal: number; confirmedReceived: number }): number {
          return Math.max(0, this.expectedTotal - this.confirmedReceived);
        },
      },
      percentReceived: {
        get(this: { expectedTotal: number; confirmedReceived: number }): number {
          if (!this.expectedTotal) return 0;
          return Math.min(100, Math.round((this.confirmedReceived / this.expectedTotal) * 1000) / 10);
        },
      },
    },
  },
);

cycleSchema.index({ groupId: 1, cycleNumber: 1 }, { unique: true });
cycleSchema.index({ status: 1, dueDate: 1 });

jsonPlugin(cycleSchema);

export const Cycle = mongoose.model('Cycle', cycleSchema);
export type CycleDoc = HydratedDocumentFromSchema<typeof cycleSchema>;
