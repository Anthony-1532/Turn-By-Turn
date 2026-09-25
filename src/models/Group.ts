import mongoose, { type HydratedDocumentFromSchema } from 'mongoose';
import { jsonPlugin } from './plugins';
import { FREQUENCIES, type Frequency } from '../utils/dates';

export const GROUP_STATUSES = ['draft', 'active', 'completed'] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

const groupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    coordinatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Whether the coordinator also contributes and takes a turn (the common ajo arrangement).
    coordinatorParticipates: { type: Boolean, default: true },

    contributionAmount: { type: Number, min: 0 }, // kobo, per member per cycle
    memberCount: { type: Number, min: 2, max: 100 },
    cycleFrequency: { type: String, enum: FREQUENCIES as readonly Frequency[] },
    firstDueDate: Date,
    platformFeeBps: { type: Number, default: 200, required: true },

    // Ordered Membership ids; index 0 receives the first payout. Locked on activation.
    payoutOrder: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Membership' }],

    status: { type: String, enum: GROUP_STATUSES, default: 'draft' as GroupStatus, required: true },
    activatedAt: Date,
    completedAt: Date,
    currentCycleNumber: { type: Number, default: 0 },

    inviteCode: { type: String, required: true },
    rules: [{ type: String, trim: true }],
  },
  {
    timestamps: true,
    virtuals: {
      expectedCycleTotal: {
        get(this: { contributionAmount?: number | null; memberCount?: number | null }): number | null {
          if (!this.contributionAmount || !this.memberCount) return null;
          return this.contributionAmount * this.memberCount;
        },
      },
      platformFeePercent: {
        get(this: { platformFeeBps: number }): number {
          return this.platformFeeBps / 100;
        },
      },
      isLocked: {
        get(this: { status: GroupStatus }): boolean {
          return this.status !== 'draft';
        },
      },
    },
  },
);

groupSchema.index({ inviteCode: 1 }, { unique: true });
groupSchema.index({ coordinatorId: 1, status: 1 });
groupSchema.index({ status: 1 });

jsonPlugin(groupSchema);

export const Group = mongoose.model('Group', groupSchema);
export type GroupDoc = HydratedDocumentFromSchema<typeof groupSchema>;
