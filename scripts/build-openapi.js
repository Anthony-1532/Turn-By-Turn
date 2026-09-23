'use strict';

/**
 * Generates docs/openapi.json (OpenAPI 3.0, importable into Postman) from the endpoint table
 * below. Run `npm run docs` after changing routes.
 */

const fs = require('fs');
const path = require('path');
const { ErrorCodes } = require('../src/utils/errors');

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });
const s = (extra = {}) => ({ type: 'string', ...extra });
const i = (description) => ({ type: 'integer', ...(description ? { description } : {}) });
const b = () => ({ type: 'boolean' });
const arr = (items) => ({ type: 'array', items });
const kobo = (description = 'Amount in kobo (₦1 = 100)') => ({ type: 'integer', description });
const id = s({ pattern: '^[a-f0-9]{24}$' });

const schemas = {
  Error: obj(
    {
      error: obj(
        {
          code: s({ enum: Object.keys(ErrorCodes) }),
          message: s(),
          retryAfter: i('Seconds; also sent as Retry-After header'),
          details: {},
        },
        ['code', 'message'],
      ),
    },
    ['error'],
  ),
  Session: obj({ accessToken: s(), accessTokenExpiresIn: i(), refreshToken: s(), tokenType: s({ example: 'Bearer' }) }),
  BankAccount: obj({ bankCode: s(), bankName: s(), accountNumber: s(), accountName: s(), verified: b(), nameMatch: b(), verifiedAt: s({ format: 'date-time' }) }),
  User: obj({
    id,
    name: s(),
    phone: s({ example: '+2348031000001' }),
    email: s(),
    status: s({ enum: ['pending_verification', 'pending_password', 'active', 'suspended'] }),
    profilePhotoUrl: s({ nullable: true }),
    initials: s(),
    income: obj({ fixedIncome: kobo(), variableIncome: kobo() }),
    bankAccount: ref('BankAccount'),
    trustedContact: obj({ name: s(), phone: s(), relationship: s(), skipped: b() }),
    notificationPreferences: ref('NotificationPreferences'),
    onboarding: obj({ phoneVerified: b(), passwordSet: b(), payoutAccountLinked: b(), trustedContactDone: b() }),
    groupCount: i(),
  }),
  NotificationPreferences: obj({ push: b(), email: b(), sms: b(), paymentReminders: b(), groupActivity: b(), announcements: b(), payoutUpdates: b() }),
  FeeBreakdown: obj({ contribution: kobo(), serviceFee: kobo('2% on top'), total: kobo(), feePercent: { type: 'number' } }),
  Group: obj({
    id,
    name: s(),
    description: s(),
    coordinatorId: id,
    coordinatorParticipates: b(),
    contributionAmount: kobo(),
    memberCount: i(),
    cycleFrequency: s({ enum: ['weekly', 'biweekly', 'monthly'] }),
    firstDueDate: s({ format: 'date-time' }),
    expectedCycleTotal: kobo('contributionAmount × memberCount'),
    platformFeeBps: i(),
    platformFeePercent: { type: 'number' },
    payoutOrder: arr(id),
    status: s({ enum: ['draft', 'active', 'completed'] }),
    isLocked: b(),
    currentCycleNumber: i(),
    inviteCode: s(),
    inviteLink: s(),
    rules: arr(s()),
    feeNote: s({ example: 'TurnByTurn fee: 2% added on top' }),
    perMemberCharge: ref('FeeBreakdown'),
  }),
  Member: obj({
    membershipId: id,
    userId: { ...id, nullable: true },
    name: s(),
    initials: s(),
    profilePhotoUrl: s({ nullable: true }),
    phone: s(),
    role: s({ enum: ['member', 'coordinator'] }),
    status: s({ enum: ['pending', 'invited', 'joined', 'removed'] }),
    participant: b(),
    payoutPosition: { type: 'integer', nullable: true },
    hasReceivedPayout: b(),
  }),
  SetupStatus: obj({
    steps: obj({ basics: b(), cycle: b(), members: b(), payoutOrder: b() }),
    participantsAdded: i(),
    missing: arr(s()),
    readyToActivate: b(),
  }),
  DraftView: obj({ group: ref('Group'), setup: ref('SetupStatus'), members: arr(ref('Member')) }),
  Cycle: obj({
    id,
    groupId: id,
    cycleNumber: i(),
    periodLabel: s({ example: 'September cycle' }),
    dueDate: s({ format: 'date-time' }),
    daysUntilDue: i(),
    expectedTotal: kobo(),
    confirmedReceived: kobo(),
    outstandingAmount: kobo(),
    percentReceived: { type: 'number' },
    status: s({ enum: ['open', 'complete', 'overdue', 'resolution_required'] }),
    recipientMembershipId: id,
  }),
  Contribution: obj({
    id,
    cycleId: id,
    membershipId: id,
    amountDue: kobo(),
    amountPaid: kobo(),
    outstandingAmount: kobo(),
    serviceFeePaid: kobo(),
    excessAmount: kobo('Confirmed beyond what was owed; pending manual review'),
    status: s({ enum: ['unpaid', 'partial', 'paid', 'reconciliation_required', 'under_review'] }),
    lastPaymentReference: s(),
  }),
  RosterRow: {
    allOf: [
      ref('Member'),
      obj({ contributionId: id, amountDue: kobo(), amountPaid: kobo(), outstanding: kobo(), status: s(), paidAt: s({ format: 'date-time' }), isRecipient: b() }),
    ],
  },
  PaymentRoster: obj({ cycle: ref('Cycle'), paidCount: i(), unpaidCount: i(), members: arr(ref('RosterRow')) }),
  Quote: {
    allOf: [
      ref('FeeBreakdown'),
      obj({ kind: s({ enum: ['full', 'partial'] }), amountDue: kobo(), alreadyPaid: kobo(), outstandingBefore: kobo(), remainingAfter: kobo() }),
    ],
  },
  PaymentAttempt: obj({
    id,
    reference: s({ example: 'TRX-0926-0042' }),
    kind: s({ enum: ['full', 'partial'] }),
    amount: kobo(),
    serviceFee: kobo(),
    totalCharged: kobo(),
    status: s({ enum: ['pending', 'processing', 'success', 'failed', 'abandoned'] }),
    checkoutUrl: s(),
    gatewayAmountReceived: kobo(),
    amountCredited: kobo(),
    excessAmount: kobo(),
    confirmedAt: s({ format: 'date-time' }),
  }),
  Receipt: obj({
    reference: s(),
    status: s(),
    kind: s(),
    paidAt: s({ format: 'date-time' }),
    payer: obj({ id, name: s(), phone: s() }),
    group: obj({ id, name: s() }),
    cycle: obj({ id, number: i(), periodLabel: s(), dueDate: s({ format: 'date-time' }) }),
    contribution: kobo(),
    serviceFee: kobo(),
    total: kobo(),
    amountReceived: kobo(),
    amountCredited: kobo(),
    excessAmount: kobo(),
    cycleBalance: obj({ amountDue: kobo(), amountPaid: kobo(), outstanding: kobo() }),
    currency: s({ example: 'NGN' }),
  }),
  Payout: obj({
    id,
    status: s({ enum: ['blocked', 'eligible', 'processing', 'sent', 'failed', 'delayed_recovery'] }),
    expectedAmount: kobo(),
    confirmedAmount: kobo(),
    outstandingAmount: kobo(),
    reference: s({ example: 'PAY-0926-0003' }),
    destination: obj({ bankCode: s(), bankName: s(), accountNumber: s(), accountName: s() }),
    attempts: arr(obj({ reference: s(), status: s(), startedAt: s(), finishedAt: s(), failureReason: s() })),
    sentAt: s({ format: 'date-time' }),
    failureReason: s(),
    group: obj({ id, name: s() }),
    cycle: obj({ id, number: i(), periodLabel: s(), dueDate: s(), status: s() }),
    recipient: obj({ id, name: s(), initials: s() }),
    blockingMembers: arr(obj({ membershipId: id, name: s(), outstanding: kobo() })),
  }),
  Transaction: obj({
    id,
    type: s({ enum: ['contribution', 'fee', 'payout', 'refund', 'adjustment'] }),
    direction: s({ enum: ['debit', 'credit'] }),
    amount: kobo(),
    status: s({ enum: ['pending', 'success', 'failed', 'under_review', 'reversed'] }),
    reference: s(),
    groupId: id,
    groupName: s(),
    cycleId: id,
    description: s(),
    createdAt: s({ format: 'date-time' }),
    meta: { type: 'object' },
  }),
  Notification: obj({ id, type: s(), title: s(), body: s(), groupId: id, data: { type: 'object' }, read: b(), createdAt: s({ format: 'date-time' }) }),
  Activity: obj({ id, groupId: id, actorId: id, actorName: s(), eventType: s(), summary: s(), createdAt: s({ format: 'date-time' }) }),
  Announcement: obj({ id, groupId: id, authorId: id, authorName: s(), title: s(), body: s(), createdAt: s({ format: 'date-time' }) }),
  Ticket: obj({ id, kind: s({ enum: ['cycle_resolution', 'reconciliation', 'payout', 'general'] }), status: s({ enum: ['open', 'resolved'] }), message: s(), createdAt: s() }),
};

// [method, path, tag, summary, {auth, body, query, res, errors, status}]
const E = [];
const add = (method, p, tag, summary, o = {}) => E.push({ method, p, tag, summary, ...o });

// --- Auth
add('post', '/auth/signup', 'Auth', 'Create Account (1/4): send SMS code', { auth: false, status: 201, body: obj({ name: s(), phone: s({ example: '08031234567' }), email: s() }, ['name', 'phone', 'email']), res: obj({ signupId: id, phone: s(), expiresIn: i(), resendAvailableIn: i() }), errors: ['ACCOUNT_EXISTS', 'OTP_RESEND_COOLDOWN', 'TOO_MANY_ATTEMPTS', 'VALIDATION_ERROR'] });
add('post', '/auth/resend-otp', 'Auth', 'Resend code (cooldown enforced)', { auth: false, body: obj({ phone: s(), purpose: s({ enum: ['signup', 'reset_password'] }) }, ['phone']), res: obj({ expiresIn: i(), resendAvailableIn: i() }), errors: ['OTP_RESEND_COOLDOWN', 'TOO_MANY_ATTEMPTS'] });
add('post', '/auth/verify-otp', 'Auth', 'Verify Contact (2/4)', { auth: false, body: obj({ phone: s(), code: s({ example: '123456' }) }, ['phone', 'code']), res: obj({ verified: b(), setupToken: s(), passwordRules: arr(s()) }), errors: ['OTP_INVALID', 'OTP_EXPIRED', 'TOO_MANY_ATTEMPTS'] });
add('post', '/auth/password-strength', 'Auth', 'Live password strength guidance', { auth: false, body: obj({ password: s() }), res: obj({ valid: b(), strength: s({ enum: ['weak', 'medium', 'strong'] }), rules: arr(s()), errors: arr(s()) }) });
add('post', '/auth/set-password', 'Auth', 'Create Password (3/4): activates account and signs in', { auth: false, status: 201, body: obj({ setupToken: s(), password: s(), confirmPassword: s() }, ['setupToken', 'password']), res: { allOf: [ref('Session'), obj({ user: ref('User'), passwordStrength: s() })] }, errors: ['PASSWORD_POLICY', 'SESSION_EXPIRED', 'ACCOUNT_EXISTS', 'SIGNUP_INCOMPLETE'] });
add('post', '/auth/sign-in', 'Auth', 'Sign In (phone or email)', { auth: false, body: obj({ identifier: s(), password: s() }, ['identifier', 'password']), res: { allOf: [ref('Session'), obj({ user: ref('User') })] }, errors: ['INVALID_CREDENTIALS', 'TOO_MANY_ATTEMPTS', 'ACCESS_DENIED'] });
add('post', '/auth/refresh', 'Auth', 'Rotate refresh token', { auth: false, body: obj({ refreshToken: s() }, ['refreshToken']), res: ref('Session'), errors: ['SESSION_EXPIRED'] });
add('post', '/auth/sign-out', 'Auth', 'Sign Out ("your records remain saved")', { body: obj({ refreshToken: s(), allDevices: b() }), res: obj({ signedOut: b() }) });
add('post', '/auth/forgot-password', 'Auth', 'Forgot Password → Reset Code Sent', { auth: false, body: obj({ identifier: s() }, ['identifier']), res: obj({ sent: b(), maskedPhone: s({ nullable: true }), expiresIn: i(), resendAvailableIn: i() }), errors: ['OTP_RESEND_COOLDOWN', 'TOO_MANY_ATTEMPTS'] });
add('post', '/auth/reset-password', 'Auth', 'Reset Password (revokes all sessions)', { auth: false, body: obj({ identifier: s(), code: s(), password: s(), confirmPassword: s() }, ['identifier', 'code', 'password']), res: obj({ reset: b() }), errors: ['OTP_INVALID', 'OTP_EXPIRED', 'PASSWORD_POLICY', 'TOO_MANY_ATTEMPTS'] });

// --- Users
add('get', '/users/me', 'Profile', 'Profile summary', { res: obj({ user: ref('User') }) });
add('patch', '/users/me', 'Profile', 'Personal Information (name, income)', { body: obj({ name: s(), income: obj({ fixedIncome: kobo(), variableIncome: kobo() }) }), res: obj({ user: ref('User') }) });
add('put', '/users/me/photo', 'Profile', 'Upload profile photo (multipart field "photo", ≤5MB)', { multipart: true, res: obj({ user: ref('User') }) });
add('delete', '/users/me/photo', 'Profile', 'Remove profile photo', { res: obj({ user: ref('User') }) });
add('post', '/users/me/bank-account/resolve', 'Profile', 'Account Verified: Squadco name lookup', { body: obj({ bankCode: s(), accountNumber: s() }, ['bankCode', 'accountNumber']), res: obj({ bankCode: s(), bankName: s(), accountNumber: s(), accountName: s(), nameMatch: b() }), errors: ['BANK_VERIFICATION_FAILED', 'GATEWAY_ERROR'] });
add('put', '/users/me/bank-account', 'Profile', 'Payout Account (4/4): save verified account', { body: obj({ bankCode: s(), accountNumber: s() }, ['bankCode', 'accountNumber']), res: obj({ bankAccount: ref('BankAccount'), user: ref('User') }), errors: ['BANK_VERIFICATION_FAILED'] });
add('get', '/users/me/bank-account', 'Profile', 'Current payout account', { res: obj({ bankAccount: ref('BankAccount') }) });
add('put', '/users/me/trusted-contact', 'Profile', 'Trusted Contact (or {"skipped": true})', { body: obj({ name: s(), phone: s(), relationship: s(), skipped: b() }), res: obj({ trustedContact: { type: 'object' } }) });
add('delete', '/users/me/trusted-contact', 'Profile', 'Remove trusted contact', { res: obj({ trustedContact: { type: 'object' } }) });
add('get', '/users/me/notification-preferences', 'Profile', 'Notification preferences', { res: obj({ preferences: ref('NotificationPreferences') }) });
add('patch', '/users/me/notification-preferences', 'Profile', 'Update notification preferences', { body: ref('NotificationPreferences'), res: obj({ preferences: ref('NotificationPreferences') }) });
add('post', '/users/me/password', 'Profile', 'Password & Security: change password', { body: obj({ currentPassword: s(), newPassword: s() }, ['currentPassword', 'newPassword']), res: { allOf: [ref('Session'), obj({ changed: b() })] }, errors: ['INVALID_CREDENTIALS', 'PASSWORD_POLICY'] });
add('post', '/users/me/devices', 'Profile', 'Register FCM device token', { status: 201, body: obj({ token: s(), platform: s({ enum: ['android', 'ios', 'web'] }) }, ['token']), res: obj({ registered: b() }) });
add('delete', '/users/me/devices', 'Profile', 'Unregister FCM device token', { body: obj({ token: s() }, ['token']), res: obj({ removed: b() }) });

// --- Home / history / notifications
add('get', '/home', 'Home', 'Member Home / Returning Home: cross-group overview', { res: obj({ summary: obj({ groupCount: i(), coordinatingCount: i(), totalOutstanding: kobo() }), nextDue: { type: 'object', nullable: true }, upcomingPayout: ref('Payout'), groups: arr({ type: 'object' }), unreadNotifications: i() }) });
add('get', '/transactions', 'History', 'Universal payment list grouped by month', { query: { month: s({ example: '2026-09' }), from: s({ format: 'date-time' }), to: s({ format: 'date-time' }), status: s({ enum: ['pending', 'success', 'failed', 'under_review', 'reversed'] }), type: s({ enum: ['contribution', 'fee', 'payout', 'refund', 'adjustment'] }), groupId: id, before: s({ format: 'date-time' }), limit: i() }, res: obj({ months: arr(obj({ month: s(), label: s(), totalOut: kobo(), totalIn: kobo(), transactions: arr(ref('Transaction')) })), count: i(), nextBefore: s({ nullable: true }) }) });
add('get', '/transactions/filters', 'History', 'Filter sheet values (period, status, type, group)', { res: obj({ periods: arr(obj({ month: s(), label: s() })), statuses: arr(s()), types: arr(s()), groups: arr(obj({ id, name: s() })) }) });
add('get', '/transactions/{id}', 'History', 'Transaction details (+ receipt / payout)', { res: obj({ transaction: ref('Transaction'), related: arr(ref('Transaction')), receipt: ref('Receipt'), payout: ref('Payout') }), errors: ['NOT_FOUND'] });
add('get', '/notifications', 'Notifications', 'List notifications', { query: { before: s({ format: 'date-time' }), limit: i(), unreadOnly: s({ enum: ['true', 'false'] }) }, res: obj({ notifications: arr(ref('Notification')), unreadCount: i(), nextBefore: s({ nullable: true }) }) });
add('post', '/notifications/read', 'Notifications', 'Mark read (ids or all)', { body: obj({ ids: arr(id), all: b() }), res: obj({ updated: i() }) });

// --- Groups
add('get', '/groups', 'Groups', 'My groups (empty array = No groups state)', { res: obj({ groups: arr({ allOf: [ref('Group'), obj({ viewerRole: s(), myPayoutPosition: i(), currentCycle: ref('Cycle'), myContribution: { type: 'object', nullable: true } })] }) }) });
add('post', '/groups', 'Group setup', 'Create group — Basics (1/5)', { status: 201, body: obj({ name: s(), contributionAmount: kobo(), description: s(), coordinatorParticipates: b() }, ['name', 'contributionAmount']), res: ref('DraftView') });
add('patch', '/groups/{id}/draft', 'Group setup', 'Basics / Cycle (2/5): partial update; returns expectedCycleTotal', { body: obj({ name: s(), description: s(), contributionAmount: kobo(), cycleFrequency: s({ enum: ['weekly', 'biweekly', 'monthly'] }), firstDueDate: s({ format: 'date' }), memberCount: i(), coordinatorParticipates: b(), rules: arr(s()) }), res: ref('DraftView'), errors: ['GROUP_NOT_DRAFT', 'ACCESS_DENIED', 'VALIDATION_ERROR'] });
add('get', '/groups/{id}/setup', 'Group setup', 'Wizard state', { res: ref('DraftView') });
add('post', '/groups/{id}/members', 'Group setup', 'Members (3/5): add by phone', { status: 201, body: obj({ phone: s(), name: s() }, ['phone']), res: { allOf: [ref('DraftView'), obj({ membership: { type: 'object' } })] }, errors: ['GROUP_NOT_DRAFT', 'GROUP_FULL', 'CONFLICT'] });
add('delete', '/groups/{id}/members/{membershipId}', 'Group setup', 'Remove member (draft only)', { res: ref('DraftView'), errors: ['GROUP_NOT_DRAFT'] });
add('put', '/groups/{id}/payout-order', 'Group setup', 'Payout Order (4/5): full permutation of membership ids', { body: obj({ order: arr(id) }, ['order']), res: ref('DraftView'), errors: ['GROUP_NOT_DRAFT', 'VALIDATION_ERROR'] });
add('get', '/groups/{id}/review', 'Group setup', 'Review (5/5)', { res: { allOf: [ref('DraftView'), obj({ summary: { type: 'object' }, warning: s(), paymentNote: s() })] } });
add('post', '/groups/{id}/activate', 'Group setup', 'Activate: lock amount & order, open cycle 1', { res: obj({ group: ref('Group'), currentCycle: ref('Cycle'), invite: obj({ code: s(), link: s() }) }), errors: ['GROUP_SETUP_INCOMPLETE', 'GROUP_NOT_DRAFT'] });
add('post', '/groups/join/preview', 'Join', 'Join Group: preview (name, amount, offered position)', { body: obj({ code: s({ example: 'TBT-AB12CD or https://turnbyturn.app/join/AB12CD' }) }, ['code']), res: obj({ group: { type: 'object' }, perMemberCharge: ref('FeeBreakdown'), offeredPosition: i(), positionIsFinal: b() }), errors: ['INVITE_INVALID', 'ALREADY_MEMBER', 'GROUP_FULL'] });
add('post', '/groups/join', 'Join', 'Join Successful', { status: 201, body: obj({ code: s() }, ['code']), res: obj({ group: ref('Group'), membership: { type: 'object' }, payoutPosition: i(), firstDueDate: s() }), errors: ['INVITE_INVALID', 'ALREADY_MEMBER', 'GROUP_FULL'] });
add('get', '/groups/{id}', 'Groups', 'Group Overview (viewerRole: coordinator | member)', { res: obj({ group: ref('Group'), viewerRole: s(), viewerLabel: s(), myContribution: ref('Contribution'), currentCycle: ref('Cycle'), progress: obj({ expected: kobo(), confirmed: kobo(), outstanding: kobo(), percentReceived: { type: 'number' }, paidCount: i(), totalMembers: i() }), nextRecipient: ref('Member'), membersPreview: arr(ref('Member')), memberTotal: i() }), errors: ['ACCESS_DENIED', 'NOT_FOUND'] });
add('get', '/groups/{id}/info', 'Groups', 'Group Information (details + rules)', { res: obj({ group: ref('Group'), coordinator: { type: 'object' }, rules: arr(s()), policies: arr(s()) }) });
add('get', '/groups/{id}/members', 'Groups', 'Group Members', { res: obj({ members: arr(ref('Member')), memberCount: i() }) });
add('get', '/groups/{id}/members/{membershipId}', 'Coordinator', 'Member Detail (coordinator or self)', { res: obj({ member: ref('Member'), currentState: { type: 'object' }, totals: obj({ required: kobo(), received: kobo(), due: kobo() }), history: arr(obj({ cycleNumber: i(), periodLabel: s(), required: kobo(), received: kobo(), due: kobo(), status: s() })), payments: arr({ type: 'object' }) }) });
add('get', '/groups/{id}/invite', 'Coordinator', 'Invite Members: code, link, share text', { res: obj({ code: s(), link: s(), canShare: b(), shareMessage: s() }) });
add('get', '/groups/{id}/payout-order', 'Groups', 'Turn order (locked after activation)', { res: obj({ locked: b(), policy: s(), order: arr({ allOf: [ref('Member'), obj({ position: i(), isMe: b(), payoutStatus: s(), cycle: { type: 'object' } })] }) }) });
add('get', '/groups/{id}/cycles', 'Cycles', 'All cycles', { res: obj({ cycles: arr(ref('Cycle')), totalCycles: i() }) });
add('get', '/groups/{id}/cycles/current', 'Cycles', 'Cycle Progress / Cycle Overdue', { res: { allOf: [ref('PaymentRoster'), obj({ outstandingMembers: arr(ref('RosterRow')), payout: ref('Payout') })] } });
add('get', '/groups/{id}/payment-status', 'Groups', 'Payment Status / Who Has Paid', { query: { cycleId: id }, res: ref('PaymentRoster') });
add('get', '/groups/{id}/payouts', 'Payouts', 'All payouts in the group', { res: obj({ payouts: arr(ref('Payout')) }) });
add('get', '/groups/{id}/dashboard', 'Coordinator', 'Manage Group dashboard', { res: obj({ group: ref('Group'), currentCycle: ref('Cycle'), collected: kobo(), expected: kobo(), remaining: kobo(), paidCount: i(), unpaidCount: i(), outstandingMembers: arr(ref('RosterRow')), nextRecipient: ref('Member'), payout: ref('Payout'), recentActivity: arr(ref('Activity')) }), errors: ['ACCESS_DENIED'] });
add('patch', '/groups/{id}/settings', 'Coordinator', 'Group Settings (name, description, rules)', { body: obj({ name: s(), description: s(), rules: arr(s()) }), res: obj({ group: ref('Group') }) });
add('get', '/groups/{id}/announcements', 'Groups', 'Announcements', { res: obj({ announcements: arr(ref('Announcement')) }) });
add('post', '/groups/{id}/announcements', 'Coordinator', 'Post announcement (push to members)', { status: 201, body: obj({ title: s(), body: s() }, ['title', 'body']), res: obj({ announcement: ref('Announcement') }) });
add('get', '/groups/{id}/activity', 'Groups', 'Group Activity feed', { query: { before: s({ format: 'date-time' }), limit: i() }, res: obj({ activity: arr(ref('Activity')), nextBefore: s({ nullable: true }) }) });
add('get', '/groups/{id}/reminders', 'Coordinator', 'Reminder history', { res: obj({ reminders: arr({ type: 'object' }), cooldownHours: i() }) });
add('post', '/groups/{id}/reminders', 'Coordinator', 'Remind outstanding members → Reminder Sent (cooldown per member)', { status: 201, body: obj({ membershipIds: arr(id), message: s(), channels: arr(s({ enum: ['push', 'sms', 'email'] })) }), res: obj({ reminder: { type: 'object' }, sentCount: i(), skipped: arr(obj({ membershipId: id, reason: s(), nextAllowedAt: s() })) }), errors: ['REMINDER_COOLDOWN', 'GROUP_NOT_ACTIVE'] });

// --- Payments
add('get', '/cycles/{id}', 'Cycles', 'Cycle detail + roster + payout', { res: { allOf: [ref('PaymentRoster'), obj({ payout: ref('Payout') })] } });
add('get', '/cycles/{id}/my-contribution', 'Payments', 'Start / Unpaid / Part paid state', { res: obj({ cycle: ref('Cycle'), contribution: ref('Contribution'), payments: arr({ type: 'object' }), acceptingPayments: b() }) });
add('get', '/cycles/{id}/contributions/quote', 'Payments', 'Review: contribution + 2% fee = total', { query: { amount: kobo('Omit for full outstanding balance') }, res: obj({ quote: ref('Quote') }), errors: ['AMOUNT_INVALID', 'NOTHING_DUE'] });
add('post', '/cycles/{id}/contributions', 'Payments', 'Pay (full or partial): returns Squadco checkout URL', { status: 201, body: obj({ amount: kobo('Omit to pay the full outstanding balance') }), res: obj({ payment: ref('PaymentAttempt'), quote: ref('Quote'), checkoutUrl: s(), reference: s() }), errors: ['AMOUNT_INVALID', 'NOTHING_DUE', 'CYCLE_CLOSED', 'GATEWAY_ERROR'] });
add('get', '/cycles/{id}/contributions', 'Payments', 'Contributions roster for a cycle', { res: ref('PaymentRoster') });
add('post', '/cycles/{id}/support', 'Payments', 'Resolution Required → Contact support', { status: 201, body: obj({ message: s() }, ['message']), res: obj({ ticket: ref('Ticket') }) });
add('post', '/payments/{reference}/verify', 'Payments', 'After checkout closes: confirm with Squadco (idempotent)', { res: obj({ payment: ref('PaymentAttempt'), contribution: ref('Contribution'), result: s({ enum: ['full_payment_received', 'partial_payment_received', 'reconciliation_required', 'pending', 'failed', 'abandoned', 'processing'] }) }) });
add('get', '/payments/{reference}', 'Payments', 'Payment status', { res: obj({ payment: ref('PaymentAttempt') }) });
add('get', '/payments/{reference}/receipt', 'Payments', 'Payment receipt (structured)', { res: obj({ receipt: ref('Receipt') }) });
add('get', '/receipts', 'Payments', 'Payment Receipts list', { query: { groupId: id, limit: i() }, res: obj({ receipts: arr(ref('Receipt')) }) });
add('get', '/contributions/{id}', 'Payments', 'Contribution', { res: obj({ contribution: ref('Contribution') }) });
add('post', '/contributions/{id}/reconcile', 'Payments', 'Reconciliation Required → Review Submitted', { status: 201, body: obj({ note: s() }), res: obj({ contribution: ref('Contribution'), ticket: ref('Ticket'), status: s({ example: 'review_submitted' }) }), errors: ['CONFLICT', 'NOT_FOUND'] });

// --- Payouts
add('get', '/payouts', 'Payouts', 'My payouts across groups', { res: obj({ payouts: arr(ref('Payout')) }) });
add('get', '/payouts/{id}', 'Payouts', 'Payout status (blocked / eligible / processing / sent / failed / delayed_recovery)', { res: obj({ payout: ref('Payout') }) });
add('post', '/payouts/{id}/start', 'Payouts', 'Payout Eligible → Start payout (coordinator)', { res: obj({ payout: ref('Payout') }), errors: ['PAYOUT_NOT_ELIGIBLE', 'PAYOUT_ACCOUNT_MISSING', 'ACCESS_DENIED'] });
add('post', '/payouts/{id}/support', 'Payouts', 'Report a payout problem', { status: 201, body: obj({ message: s() }, ['message']), res: obj({ ticket: ref('Ticket') }) });

// --- Support / public
add('post', '/support/tickets', 'Support', 'Help & Support: open a ticket', { status: 201, body: obj({ kind: s({ enum: ['general', 'payout', 'cycle_resolution'] }), message: s(), groupId: id, paymentReference: s() }, ['message']), res: obj({ ticket: ref('Ticket') }) });
add('get', '/support/tickets', 'Support', 'My tickets', { res: obj({ tickets: arr(ref('Ticket')) }) });
add('get', '/banks', 'Reference', 'Nigerian banks (Squadco bank codes)', { auth: false, res: obj({ banks: arr(obj({ code: s(), name: s() })) }) });
add('get', '/content/help', 'Reference', 'Payment Help FAQ + support contacts', { auth: false, res: { type: 'object' } });
add('get', '/invites/{code}', 'Reference', 'Public invite teaser (marketing site / deep link)', { auth: false, res: { type: 'object' }, errors: ['INVITE_INVALID'] });
add('get', '/files/{id}', 'Reference', 'Profile photo bytes', { auth: false, binary: true });

// --- Webhooks
add('post', '/webhooks/squadco', 'Webhooks', 'Squadco payment/transfer callbacks (HMAC-SHA512 x-squad-encrypted-body)', { auth: false, body: { type: 'object' }, res: obj({ received: b(), duplicate: b() }) });

// --- Admin
add('get', '/admin/tickets', 'Admin', 'Support queue', { query: { status: s({ enum: ['open', 'resolved'] }), kind: s() }, res: obj({ tickets: arr(ref('Ticket')) }) });
add('post', '/admin/tickets/{id}/resolve', 'Admin', 'Close a ticket', { body: obj({ note: s() }, ['note']), res: obj({ ticket: ref('Ticket') }) });
add('post', '/admin/contributions/{id}/reconciliation', 'Admin', 'Resolve overpayment (refunded | credited | dismissed)', { body: obj({ action: s({ enum: ['refunded', 'credited', 'dismissed'] }), note: s(), gatewayReference: s() }, ['action']), res: obj({ contribution: ref('Contribution'), adjustment: ref('Transaction') }) });
add('post', '/admin/cycles/{id}/resolve', 'Admin', 'Resolve stuck cycle (extend_deadline | release | note)', { body: obj({ action: s({ enum: ['extend_deadline', 'release', 'note'] }), note: s(), newDueDate: s({ format: 'date-time' }) }, ['action', 'note']), res: obj({ cycle: ref('Cycle') }) });
add('post', '/admin/payouts/{id}/start', 'Admin', 'Start an eligible payout', { res: obj({ payout: ref('Payout') }) });
add('post', '/admin/payouts/{id}/retry', 'Admin', 'Failed → Delayed Recovery: retry transfer', { res: obj({ payout: ref('Payout') }), errors: ['PAYOUT_NOT_ELIGIBLE', 'PAYOUT_ACCOUNT_MISSING'] });
add('post', '/admin/users/{id}/suspend', 'Admin', 'Suspend / unsuspend a user', { body: obj({ suspended: b() }, ['suspended']), res: obj({ user: ref('User') }) });

// --- Internal
add('post', '/internal/jobs/run', 'Internal', 'Run scheduled jobs (header x-cron-secret = CRON_SECRET)', { auth: false, res: { type: 'object' }, errors: ['ACCESS_DENIED'] });

// --- Dev
add('get', '/dev/checkout/{reference}', 'Dev (non-production)', 'Mock Squadco checkout page', { auth: false, binary: true });
add('post', '/dev/payments/{reference}/complete', 'Dev (non-production)', 'Simulate gateway confirmation (?fail=1, or body.amount to overpay)', { auth: false, body: obj({ amount: kobo() }), res: obj({ payment: ref('PaymentAttempt') }) });
add('post', '/dev/jobs/run', 'Dev (non-production)', 'Run scheduled jobs now', { auth: false, res: { type: 'object' } });

function errResp(codes) {
  const out = {};
  for (const c of codes) {
    const st = String(ErrorCodes[c].status);
    out[st] = out[st] || { description: '', content: { 'application/json': { schema: ref('Error') } } };
    out[st].description = out[st].description ? `${out[st].description}, ${c}` : c;
  }
  return out;
}

const paths = {};
for (const e of E) {
  const params = [...e.p.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: s() }));
  if (e.query) for (const [name, schema] of Object.entries(e.query)) params.push({ name, in: 'query', required: false, schema });
  const needsAuth = e.auth !== false;
  const codes = [...new Set([...(e.errors || []), 'VALIDATION_ERROR', ...(needsAuth ? ['UNAUTHENTICATED', 'SESSION_EXPIRED'] : [])])];
  const op = {
    tags: [e.tag],
    summary: e.summary,
    operationId: `${e.method}${e.p.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+(.)?/g, (_m, c) => (c ? c.toUpperCase() : ''))}`,
    ...(params.length ? { parameters: params } : {}),
    ...(needsAuth ? {} : { security: [] }),
    responses: {
      [String(e.status || 200)]: e.binary
        ? { description: 'OK' }
        : { description: 'OK', content: { 'application/json': { schema: e.res || { type: 'object' } } } },
      ...errResp(codes),
    },
  };
  if (e.multipart) {
    op.requestBody = { required: true, content: { 'multipart/form-data': { schema: obj({ photo: s({ format: 'binary' }) }, ['photo']) } } };
  } else if (e.body) {
    op.requestBody = { required: true, content: { 'application/json': { schema: e.body } } };
  }
  paths[e.p] = paths[e.p] || {};
  paths[e.p][e.method] = op;
}

const doc = {
  openapi: '3.0.3',
  info: {
    title: 'TurnByTurn API',
    version: '1.0.0',
    description:
      'Backend for TurnByTurn, a rotating savings (ajo / esusu) app. All money values are integer kobo. ' +
      'Errors always return `{ error: { code, message, details?, retryAfter? } }`; see docs/ERRORS.md for the code → screen map.',
  },
  servers: [{ url: '/api/v1' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas,
  },
  paths: {
    ...paths,
  },
};

const out = path.join(__dirname, '..', 'docs', 'openapi.json');
fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.info(`Wrote ${out} (${E.length} operations)`);
