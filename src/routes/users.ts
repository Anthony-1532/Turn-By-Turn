import express from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import mongoose, { type Types } from 'mongoose';
import { Readable } from 'stream';
import { User, Membership, type UserDoc, type NotificationPreferenceKey } from '../models';
import { h, auth, currentUser, parseBody } from '../middleware';
import { err } from '../utils/errors';
import * as v from '../utils/validators';
import * as squadco from '../services/squadco';
import * as tokens from '../services/tokens';
import { userView } from './auth';

const router = express.Router();
const { z } = v;

router.use(auth);

async function profile(user: UserDoc) {
  const groupCount = await Membership.countDocuments({ userId: user._id, status: 'joined' });
  return { ...userView(user), groupCount };
}

router.get('/me', h(async (req, res) => res.json({ user: await profile(currentUser(req)) })));

/** Personal Information. Phone/email changes are not self-serve (they are verified identities). */
router.patch(
  '/me',
  h(async (req, res) => {
    const user = currentUser(req);
    const incomeField = z.number().int().min(0).nullable().optional();
    const { name, income } = parseBody(
      z.object({ name: v.name.optional(), income: z.object({ fixedIncome: incomeField, variableIncome: incomeField }).optional() }).strict(),
      req,
    );
    if (name) user.name = name;
    if (income) {
      for (const k of ['fixedIncome', 'variableIncome'] as const) {
        const value = income[k];
        if (value !== undefined) user.set(`income.${k}`, value ?? undefined);
      }
    }
    await user.save();
    res.json({ user: await profile(user) });
  }),
);

// ------------------------------------------------------------------ Profile photo (GridFS)

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return cb(Object.assign(new Error('Upload a JPEG, PNG, WebP or HEIC image'), { name: 'MulterError' }));
    }
    return cb(null, true);
  },
});

export function gridfsBucket(): mongoose.mongo.GridFSBucket {
  if (!mongoose.connection.db) throw new Error('Database not connected');
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
}

async function deletePhoto(id: Types.ObjectId | null | undefined): Promise<void> {
  if (id) await gridfsBucket().delete(id).catch(() => undefined);
}

router.put(
  '/me/photo',
  upload.single('photo'),
  h(async (req, res) => {
    const user = currentUser(req);
    const file = req.file;
    if (!file) throw err('VALIDATION_ERROR', 'Attach an image in the "photo" field.');
    const id = await new Promise<Types.ObjectId>((resolve, reject) => {
      const stream = gridfsBucket().openUploadStream(`avatar-${user._id}`, {
        metadata: { userId: user._id, kind: 'avatar', contentType: file.mimetype },
      });
      Readable.from(file.buffer)
        .pipe(stream)
        .on('error', reject)
        .on('finish', () => resolve(stream.id));
    });
    const previous = user.profilePhotoFileId;
    user.profilePhotoFileId = id;
    await user.save();
    await deletePhoto(previous);
    res.json({ user: await profile(user) });
  }),
);

router.delete(
  '/me/photo',
  h(async (req, res) => {
    const user = currentUser(req);
    const previous = user.profilePhotoFileId;
    user.profilePhotoFileId = undefined;
    await user.save();
    await deletePhoto(previous);
    res.json({ user: await profile(user) });
  }),
);

// ------------------------------------------------------------------ Bank account (onboarding step 4 + Profile)

/** Loose name match between the account holder and the TurnByTurn profile name. */
export function nameMatches(profileName: string, accountName: string): { match: boolean; commonTokens: number } {
  const tokenise = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1));
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
  h(async (req, res) => {
    const { bankCode, accountNumber } = parseBody(bankInput, req);
    const r = await squadco.resolveAccount(bankCode, accountNumber);
    const m = nameMatches(currentUser(req).name, r.accountName);
    res.json({ bankCode, bankName: r.bankName, accountNumber, accountName: r.accountName, nameMatch: m.match });
  }),
);

/** Saves the payout account. Re-resolves server-side; the client-supplied name is never trusted. */
router.put(
  '/me/bank-account',
  h(async (req, res) => {
    const user = currentUser(req);
    const { bankCode, accountNumber } = parseBody(bankInput, req);
    const r = await squadco.resolveAccount(bankCode, accountNumber);
    const m = nameMatches(user.name, r.accountName);
    user.set('bankAccount', {
      bankCode,
      bankName: r.bankName,
      accountNumber,
      accountName: r.accountName,
      verified: true,
      nameMatch: m.match,
      verifiedAt: new Date(),
    });
    await user.save();
    res.json({ bankAccount: user.bankAccount, user: await profile(user) });
  }),
);

router.get('/me/bank-account', (req, res) => {
  res.json({ bankAccount: currentUser(req).bankAccount ?? null });
});

// ------------------------------------------------------------------ Trusted contact

router.put(
  '/me/trusted-contact',
  h(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(
      z.union([
        z.object({ skipped: z.literal(true) }),
        z.object({ name: v.name, phone: v.phone, relationship: z.string().trim().max(40).optional() }),
      ]),
      req,
    );
    user.set('trustedContact', 'skipped' in body ? { skipped: true } : { ...body, skipped: false });
    await user.save();
    res.json({ trustedContact: user.trustedContact });
  }),
);

router.delete(
  '/me/trusted-contact',
  h(async (req, res) => {
    const user = currentUser(req);
    user.set('trustedContact', { skipped: true });
    await user.save();
    res.json({ trustedContact: user.trustedContact });
  }),
);

// ------------------------------------------------------------------ Notification preferences

router.get('/me/notification-preferences', (req, res) => {
  res.json({ preferences: currentUser(req).notificationPreferences });
});

router.patch(
  '/me/notification-preferences',
  h(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(
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
      req,
    );
    for (const [k, val] of Object.entries(body) as Array<[NotificationPreferenceKey, boolean | undefined]>) {
      if (val !== undefined) user.set(`notificationPreferences.${k}`, val);
    }
    await user.save();
    res.json({ preferences: user.notificationPreferences });
  }),
);

// ------------------------------------------------------------------ Password & Security

router.post(
  '/me/password',
  h(async (req, res) => {
    const user = currentUser(req);
    const { currentPassword, newPassword } = parseBody(z.object({ currentPassword: z.string().min(1), newPassword: v.password }), req);
    const ok = await bcrypt.compare(currentPassword, user.passwordHash ?? '');
    if (!ok) throw err('INVALID_CREDENTIALS', 'Current password is incorrect.');
    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.passwordChangedAt = new Date(Date.now() - 1000);
    await user.save();
    await tokens.revokeAllForUser(user._id);
    const session = await tokens.issueSession(user, { userAgent: req.get('user-agent'), ip: req.ip });
    res.json({ changed: true, ...session });
  }),
);

// ------------------------------------------------------------------ Push devices

router.post(
  '/me/devices',
  h(async (req, res) => {
    const user = currentUser(req);
    const { token, platform } = parseBody(
      z.object({ token: z.string().min(10).max(4096), platform: z.enum(['android', 'ios', 'web']).default('android') }),
      req,
    );
    // A token belongs to one device, so detach it from any other account first.
    await User.updateMany({ _id: { $ne: user._id } }, { $pull: { deviceTokens: { token } } });
    await User.updateOne({ _id: user._id }, { $pull: { deviceTokens: { token } } });
    await User.updateOne(
      { _id: user._id },
      { $push: { deviceTokens: { $each: [{ token, platform, updatedAt: new Date() }], $slice: -10 } } },
    );
    res.status(201).json({ registered: true });
  }),
);

router.delete(
  '/me/devices',
  h(async (req, res) => {
    const { token } = parseBody(z.object({ token: z.string().min(10) }), req);
    await User.updateOne({ _id: currentUser(req)._id }, { $pull: { deviceTokens: { token } } });
    res.json({ removed: true });
  }),
);

export default router;
