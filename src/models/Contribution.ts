import mongoose, { type HydratedDocumentFromSchema } from 'mongoose';
import { jsonPlugin, noDeletePlugin } from './plugins';

export const CONTRIBUTION_STATUSES = ['unpaid', 'partial', 'paid', 'reconciliation_required', 'under_review'] as const;
export type ContributionStatus = (typeof CONTRIBUTION_STATUSES)[number];

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
    amountPaid: { type: Number, default: 0, required: true },
    serviceFeePaid: { type: Number, default: 0, required: true },
    totalCharged: { type: Number, default: 0, required: true },
    // Money the gateway confirmed beyond what was required; held for manual review.
    excessAmount: { type: Number, default: 0, required: true },
    status: { type: String, enum: CONTRIBUTION_STATUSES, default: 'unpaid' as ContributionStatus, required: true },
    lastPaymentReference: String,
    paidAt: Date, // first payment
    confirmedAt: Date, // fully paid
  },
  {
    timestamps: true,
    virtuals: {
      outstandingAmount: {
        get(this: { amountDue: number; amountPaid: number }): number {
          return Math.max(0, this.amountDue - this.amountPaid);
        },
      },
    },
  },
);

contributionSchema.index({ cycleId: 1, membershipId: 1 }, { unique: true });
contributionSchema.index({ userId: 1, createdAt: -1 });
contributionSchema.index({ groupId: 1, status: 1 });

noDeletePlugin(contributionSchema);
jsonPlugin(contributionSchema);

export const Contribution = mongoose.model('Contribution', contributionSchema);
export type ContributionDoc = HydratedDocumentFromSchema<typeof contributionSchema>;
