import mongoose, { type HydratedDocumentFromSchema } from 'mongoose';
import { jsonPlugin, noDeletePlugin } from './plugins';

export const PAYOUT_STATUSES = ['blocked', 'eligible', 'processing', 'sent', 'failed', 'delayed_recovery'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export type TransferAttemptStatus = 'processing' | 'sent' | 'failed';

const payoutSchema = new mongoose.Schema(
  {
    cycleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cycle', required: true },
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    recipientMembershipId: { type: mongoose.Schema.Types.ObjectId, ref: 'Membership', required: true },
    recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: PAYOUT_STATUSES, default: 'blocked' as PayoutStatus, required: true },
    expectedAmount: { type: Number, required: true },
    confirmedAmount: { type: Number, default: 0, required: true },
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
        reference: { type: String, required: true },
        status: { type: String, enum: ['processing', 'sent', 'failed'] as TransferAttemptStatus[], required: true },
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
  {
    timestamps: true,
    virtuals: {
      outstandingAmount: {
        get(this: { expectedAmount: number; confirmedAmount: number }): number {
          return Math.max(0, this.expectedAmount - this.confirmedAmount);
        },
      },
    },
  },
);

payoutSchema.index({ cycleId: 1 }, { unique: true });
payoutSchema.index({ status: 1, updatedAt: 1 });
payoutSchema.index({ recipientUserId: 1, createdAt: -1 });
payoutSchema.index({ reference: 1 }, { sparse: true });

noDeletePlugin(payoutSchema);
jsonPlugin(payoutSchema);

export const Payout = mongoose.model('Payout', payoutSchema);
export type PayoutDoc = HydratedDocumentFromSchema<typeof payoutSchema>;
