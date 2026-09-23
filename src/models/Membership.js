'use strict';

const mongoose = require('mongoose');
const { jsonPlugin } = require('./plugins');

/**
 * Join between User and Group. Role is per group, so the same user can coordinate one group
 * and be a plain member of another.
 *
 * status:
 *   pending  – coordinator added a phone number that has no TurnByTurn account yet
 *   invited  – coordinator added an existing user who has not accepted yet
 *   joined   – user is in the group
 *   removed  – removed while the group was still a draft
 */
const membershipSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    removedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // userId is moved here on removal
    role: { type: String, enum: ['member', 'coordinator'], default: 'member' },
    // False only for a coordinator who manages without contributing.
    participant: { type: Boolean, default: true },
    status: { type: String, enum: ['pending', 'invited', 'joined', 'removed'], default: 'joined' },
    inviteName: String,
    invitePhone: String,
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    joinedAt: Date,
    payoutPosition: { type: Number, min: 1 },
    hasReceivedPayout: { type: Boolean, default: false },
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

module.exports = mongoose.model('Membership', membershipSchema);
