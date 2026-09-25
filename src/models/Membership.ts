import mongoose, { type HydratedDocumentFromSchema } from 'mongoose';
import { jsonPlugin } from './plugins';

export const MEMBERSHIP_ROLES = ['member', 'coordinator'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * status:
 *   pending  – coordinator added a phone number that has no TurnByTurn account yet
 *   invited  – coordinator added an existing user who has not accepted yet
 *   joined   – user is in the group
 *   removed  – removed while the group was still a draft
 */
export const MEMBERSHIP_STATUSES = ['pending', 'invited', 'joined', 'removed'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * Join between User and Group. Role is per group, so the same user can coordinate one group
 * and be a plain member of another.
 */
const membershipSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    removedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // userId is moved here on removal
    role: { type: String, enum: MEMBERSHIP_ROLES, default: 'member' as MembershipRole, required: true },
    // False only for a coordinator who manages without contributing.
    participant: { type: Boolean, default: true, required: true },
    status: { type: String, enum: MEMBERSHIP_STATUSES, default: 'joined' as MembershipStatus, required: true },
    inviteName: String,
    invitePhone: String,
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    joinedAt: Date,
    payoutPosition: { type: Number, min: 1 },
    hasReceivedPayout: { type: Boolean, default: false, required: true },
  },
  { timestamps: true },
);

membershipSchema.index(
  { groupId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } },
);
membershipSchema.index({ userId: 1, status: 1 });
membershipSchema.index({ groupId: 1, status: 1 });
membershipSchema.index({ invitePhone: 1, status: 1 });

jsonPlugin(membershipSchema);

export const Membership = mongoose.model('Membership', membershipSchema);
export type MembershipDoc = HydratedDocumentFromSchema<typeof membershipSchema>;
