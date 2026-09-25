import mongoose, { type HydratedDocumentFromSchema } from 'mongoose';
import { jsonPlugin, noDeletePlugin } from './plugins';

export const PAYMENT_KINDS = ['full', 'partial'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

// pending → processing (claimed by a webhook/verify) → success | failed | abandoned
export const PAYMENT_STATUSES = ['pending', 'processing', 'success', 'failed', 'abandoned'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

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
    kind: { type: String, enum: PAYMENT_KINDS, required: true },
    amount: { type: Number, required: true }, // principal, kobo
    serviceFee: { type: Number, required: true },
    totalCharged: { type: Number, required: true },
    status: { type: String, enum: PAYMENT_STATUSES, default: 'pending' as PaymentStatus, required: true },
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

export const PaymentAttempt = mongoose.model('PaymentAttempt', paymentAttemptSchema);
export type PaymentAttemptDoc = HydratedDocumentFromSchema<typeof paymentAttemptSchema>;
