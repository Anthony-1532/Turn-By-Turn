'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const mongoose = require('mongoose');
const { Readable } = require('stream');
const { User, Membership } = require('../models');
const { h, auth, validate } = require('../middleware');
const { err } = require('../utils/errors');
const v = require('../utils/validators');
const squadco = require('../services/squadco');
const tokens = require('../services/tokens');
const { userView } = require('./auth');

const router = express.Router();
const { z } = v;

router.use(auth);

async function profile(user) {
  const groupCount = await Membership.countDocuments({ userId: user._id, status: 'joined' });
  return { ...userView(user), groupCount };
}

router.get('/me', h(async (req, res) => res.json({ user: await profile(req.user) })));

/** Personal Information. Phone/email changes are not self-serve (they are verified identities). */
router.patch(
  '/me',
  validate(
    z
      .object({
        name: v.name.optional(),
        income: z
          .object({ fixedIncome: z.number().int().min(0).nullable().optional(), variableIncome: z.number().int().min(0).nullable().optional() })
          .optional(),
      })
      .strict(),
  ),
  h(async (req, res) => {
    const { name, income } = req.body;
    if (name) req.user.name = name;
    if (income) {
      for (const k of ['fixedIncome', 'variableIncome']) {
        if (income[k] !== undefined) req.user.set(`income.${k}`, income[k] === null ? undefined : income[k]);
      }
    }
    await req.user.save();
    res.json({ user: await profile(req.user) });
  }),
);

// ------------------------------------------------------------------ Profile photo (GridFS)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(file.mimetype)) {
      return cb(Object.assign(new Error('Upload a JPEG, PNG, WebP or HEIC image'), { name: 'MulterError' }));
    }
    return cb(null, true);
  },
});

function bucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
}

router.put(
  '/me/photo',
  upload.single('photo'),
  h(async (req, res) => {
    if (!req.file) throw err('VALIDATION_ERROR', 'Attach an image in the "photo" field.');
    const b = bucket();
    const id = await new Promise((resolve, reject) => {
      const stream = b.openUploadStream(`avatar-${req.user._id}`, {
        metadata: { userId: req.user._id, kind: 'avatar', contentType: req.file.mimetype },
      });
      Readable.from(req.file.buffer).pipe(stream).on('error', reject).on('finish', () => resolve(stream.id));
    });
    const previous = req.user.profilePhotoFileId;
    req.user.profilePhotoFileId = id;
    await req.user.save();
    if (previous) await b.delete(previous).catch(() => {});
    res.json({ user: await profile(req.user) });
  }),
);

router.delete(
  '/me/photo',
  h(async (req, res) => {
    const previous = req.user.profilePhotoFileId;
    req.user.profilePhotoFileId = undefined;
    await req.user.save();
    if (previous) await bucket().delete(previous).catch(() => {});
    res.json({ user: await profile(req.user) });
  }),
);

// ------------------------------------------------------------------ Bank account (onboarding step 4 + Profile)

/** Loose name match between the account holder and the TurnByTurn profile name. */
function nameMatches(profileName, accountName) {
  const tokenise = (s) => new Set(String(s).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1));
  const a = tokenise(profileName);
  const b = tokenise(accountName);
  let common = 0;
  for (const t of a) if (b.has(t)) common += 1;
  return { match: common >= Math.min(2, a.size), commonTokens: common };
}

const bankInput = z.object({
  bankCode: z.string().regex(/^\d{3,6}$/, 'Select a bank'),
  accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
});

/** Account Verified screen: resolves the name so the user can confirm before saving. */
router.post(
  '/me/bank-account/resolve',
  validate(bankInput),
  h(async (req, res) => {
    const { bankCode, accountNumber } = req.body;
    const r = await squadco.resolveAccount(bankCode, accountNumber);
    const m = nameMatches(req.user.name, r.accountName);
    res.json({ bankCode, bankName: r.bankName, accountNumber, accountName: r.accountName, nameMatch: m.match });
  }),
);

/** Saves the payout account. Re-resolves server-side; the client-supplied name is never trusted. */
router.put(
  '/me/bank-account',
  validate(bankInput),
  h(async (req, res) => {
    const { bankCode, accountNumber } = req.body;
    const r = await squadco.resolveAccount(bankCode, accountNumber);
    const m = nameMatches(req.user.name, r.accountName);
    req.user.bankAccount = {
      bankCode,
      bankName: r.bankName,
      accountNumber,
      accountName: r.accountName,
      verified: true,
      nameMatch: m.match,
      verifiedAt: new Date(),
    };
    await req.user.save();
    res.json({ bankAccount: req.user.bankAccount, user: await profile(req.user) });
  }),
);

router.get('/me/bank-account', (req, res) => res.json({ bankAccount: req.user.bankAccount || null }));

// ------------------------------------------------------------------ Trusted contact

router.put(
  '/me/trusted-contact',
  validate(
    z.union([
      z.object({ skipped: z.literal(true) }),
      z.object({ name: v.name, phone: v.phone, relationship: z.string().trim().max(40).optional() }),
    ]),
  ),
  h(async (req, res) => {
    req.user.trustedContact = req.body.skipped ? { skipped: true } : { ...req.body, skipped: false };
    await req.user.save();
    res.json({ trustedContact: req.user.trustedContact });
  }),
);

router.delete(
  '/me/trusted-contact',
  h(async (req, res) => {
    req.user.trustedContact = { skipped: true };
    await req.user.save();
    res.json({ trustedContact: req.user.trustedContact });
  }),
);

// ------------------------------------------------------------------ Notification preferences

router.get('/me/notification-preferences', (req, res) => res.json({ preferences: req.user.notificationPreferences }));

router.patch(
  '/me/notification-preferences',
  validate(
    z
      .object({
        push: z.boolean(),
        email: z.boolean(),
        sms: z.boolean(),
        paymentReminders: z.boolean(),
        groupActivity: z.boolean(),
        announcements: z.boolean(),
        payoutUpdates: z.boolean(),
      })
      .partial()
      .strict(),
  ),
  h(async (req, res) => {
    for (const [k, val] of Object.entries(req.body)) req.user.set(`notificationPreferences.${k}`, val);
    await req.user.save();
    res.json({ preferences: req.user.notificationPreferences });
  }),
);

// ------------------------------------------------------------------ Password & Security

router.post(
  '/me/password',
  validate(z.object({ currentPassword: z.string().min(1), newPassword: v.password })),
  h(async (req, res) => {
    const ok = await bcrypt.compare(req.body.currentPassword, req.user.passwordHash || '');
    if (!ok) throw err('INVALID_CREDENTIALS', 'Current password is incorrect.');
    req.user.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    req.user.passwordChangedAt = new Date(Date.now() - 1000);
    await req.user.save();
    await tokens.revokeAllForUser(req.user._id);
    const session = await tokens.issueSession(req.user, { userAgent: req.get('user-agent'), ip: req.ip });
    res.json({ changed: true, ...session });
  }),
);

// ------------------------------------------------------------------ Push devices

router.post(
  '/me/devices',
  validate(z.object({ token: z.string().min(10).max(4096), platform: z.enum(['android', 'ios', 'web']).default('android') })),
  h(async (req, res) => {
    const { token, platform } = req.body;
    // A token belongs to one device, so detach it from any other account first.
    await User.updateMany({ _id: { $ne: req.user._id } }, { $pull: { deviceTokens: { token } } });
    await User.updateOne({ _id: req.user._id }, { $pull: { deviceTokens: { token } } });
    await User.updateOne(
      { _id: req.user._id },
      { $push: { deviceTokens: { $each: [{ token, platform, updatedAt: new Date() }], $slice: -10 } } },
    );
    res.status(201).json({ registered: true });
  }),
);

router.delete(
  '/me/devices',
  validate(z.object({ token: z.string().min(10) })),
  h(async (req, res) => {
    await User.updateOne({ _id: req.user._id }, { $pull: { deviceTokens: { token: req.body.token } } });
    res.json({ removed: true });
  }),
);

module.exports = router;
module.exports.nameMatches = nameMatches;
module.exports.gridfsBucket = bucket;
