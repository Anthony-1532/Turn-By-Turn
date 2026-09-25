import express, { type Request } from 'express';
import bcrypt from 'bcryptjs';
import { config } from '../config/env';
import { User, toJson, type UserDoc } from '../models';
import { h, auth, currentUser, parseBody } from '../middleware';
import { err } from '../utils/errors';
import * as v from '../utils/validators';
import * as otp from '../services/otp';
import * as tokens from '../services/tokens';
import * as rateLimiter from '../services/rateLimiter';

const router = express.Router();
const { z } = v;

const meta = (req: Request) => ({ userAgent: req.get('user-agent'), ip: req.ip });

export function userView(user: UserDoc) {
  return {
    ...toJson(user),
    onboarding: {
      phoneVerified: Boolean(user.phoneVerifiedAt),
      passwordSet: Boolean(user.passwordHash),
      payoutAccountLinked: Boolean(user.bankAccount?.verified),
      trustedContactDone: Boolean(user.trustedContact?.phone || user.trustedContact?.skipped),
    },
  };
}

async function findByIdentifier(identifier: string): Promise<UserDoc | null> {
  const phone = v.normalisePhone(identifier);
  const status = { $in: ['active', 'suspended'] as const };
  if (phone) return User.findOne({ phone, status });
  return User.findOne({ email: identifier.trim().toLowerCase(), status });
}

// ------------------------------------------------------------------ Sign-up (steps 1–3 of 4)

/** Create Account (1/4): name, phone, email → sends the SMS code. Re-calling = "change number". */
router.post(
  '/signup',
  h(async (req, res) => {
    const { name, phone, email } = parseBody(z.object({ name: v.name, phone: v.phone, email: v.email }), req);
    const clash = await User.findOne({ status: { $in: ['active', 'suspended'] }, $or: [{ phone }, { email }] });
    if (clash) {
      throw err('ACCOUNT_EXISTS', undefined, { details: { field: clash.phone === phone ? 'phone' : 'email' } });
    }
    // Reuse an abandoned sign-up with the same email or phone so retries don't pile up.
    let user = await User.findOne({ status: { $in: ['pending_verification', 'pending_password'] }, $or: [{ email }, { phone }] });
    if (user) {
      user.set({ name, phone, email, status: 'pending_verification', phoneVerifiedAt: undefined });
      await user.save();
    } else {
      user = await User.create({ name, phone, email });
    }
    const sent = await otp.sendOtp({ phone, email, purpose: 'signup' });
    res.status(201).json({ signupId: String(user._id), phone, ...sent });
  }),
);

router.post(
  '/resend-otp',
  h(async (req, res) => {
    const { phone, purpose } = parseBody(
      z.object({ phone: v.phone, purpose: z.enum(['signup', 'reset_password']).default('signup') }),
      req,
    );
    const user = await User.findOne({ phone, status: purpose === 'signup' ? 'pending_verification' : 'active' });
    if (!user) {
      if (purpose === 'signup') throw err('NOT_FOUND', 'Start sign-up again.');
      return res.json({ expiresIn: config.otp.ttlSeconds, resendAvailableIn: config.otp.resendCooldownSeconds });
    }
    return res.json(await otp.sendOtp({ phone, email: user.email, purpose }));
  }),
);

/** Verify Contact (2/4). Returns a short-lived setupToken for Create Password. */
router.post(
  '/verify-otp',
  h(async (req, res) => {
    const { phone, code } = parseBody(
      z.object({ phone: v.phone, code: z.string().regex(/^\d{4,8}$/, 'Enter the code from the SMS') }),
      req,
    );
    const user = await User.findOne({ phone, status: 'pending_verification' });
    if (!user) throw err('OTP_EXPIRED', 'Start sign-up again.');
    await otp.verifyOtp({ phone, purpose: 'signup', code });
    user.phoneVerifiedAt = new Date();
    user.status = 'pending_password';
    await user.save();
    res.json({ verified: true, setupToken: tokens.signSetupToken(user._id, 'signup'), passwordRules: v.PASSWORD_RULES });
  }),
);

/** Create Password (3/4). Activates the account and signs the user in. */
router.post(
  '/set-password',
  h(async (req, res) => {
    const { setupToken, password, confirmPassword } = parseBody(
      z.object({ setupToken: z.string().min(10), password: v.password, confirmPassword: z.string().optional() }),
      req,
    );
    if (confirmPassword !== undefined && confirmPassword !== password) {
      throw err('PASSWORD_POLICY', 'Passwords do not match.', {
        details: [{ field: 'confirmPassword', message: 'Passwords do not match' }],
      });
    }
    const payload = tokens.verifyJwt(setupToken, 'setup');
    if (payload.pur !== 'signup') throw err('UNAUTHENTICATED', 'Invalid token.');
    const user = await User.findById(payload.sub);
    if (!user || user.status !== 'pending_password') throw err('SIGNUP_INCOMPLETE');

    // A parallel sign-up may have completed with the same details in the meantime.
    const clash = await User.findOne({ _id: { $ne: user._id }, status: 'active', $or: [{ phone: user.phone }, { email: user.email }] });
    if (clash) throw err('ACCOUNT_EXISTS');

    user.passwordHash = await bcrypt.hash(password, 12);
    user.status = 'active';
    user.lastLoginAt = new Date();
    await user.save();
    const session = await tokens.issueSession(user, meta(req));
    res.status(201).json({ user: userView(user), ...session, passwordStrength: v.passwordStrength(password) });
  }),
);

/** Live strength guidance for the Create Password screen. */
router.post(
  '/password-strength',
  h((req, res) => {
    const { password } = parseBody(z.object({ password: z.string().max(128) }), req);
    const r = v.password.safeParse(password);
    res.json({
      valid: r.success,
      strength: v.passwordStrength(password),
      rules: v.PASSWORD_RULES,
      errors: r.success ? [] : r.error.issues.map((i) => i.message),
    });
  }),
);

// ------------------------------------------------------------------ Sign in / sessions

router.post(
  '/sign-in',
  h(async (req, res) => {
    const { identifier, password } = parseBody(
      z.object({ identifier: z.string().trim().min(3), password: z.string().min(1).max(128) }),
      req,
    );
    const key = `signin:${v.normalisePhone(identifier) ?? identifier.toLowerCase()}`;
    await rateLimiter.assertNotLocked(key);
    const user = await findByIdentifier(identifier);
    const ok = Boolean(user?.passwordHash && (await bcrypt.compare(password, user.passwordHash)));
    if (!user || !ok) {
      const r = await rateLimiter.hit(key, {
        max: config.rateLimit.signInMaxFailures,
        windowSeconds: config.rateLimit.signInWindowSeconds,
        lockSeconds: config.rateLimit.lockoutSeconds,
      });
      if (r.locked) throw err('TOO_MANY_ATTEMPTS', undefined, { retryAfter: r.retryAfter });
      throw err('INVALID_CREDENTIALS', undefined, {
        details: { attemptsRemaining: Math.max(0, config.rateLimit.signInMaxFailures - r.count) },
      });
    }
    if (user.status === 'suspended') throw err('ACCESS_DENIED', 'This account is suspended. Contact support.');
    await rateLimiter.reset(key);
    user.lastLoginAt = new Date();
    await user.save();
    const session = await tokens.issueSession(user, meta(req));
    res.json({ user: userView(user), ...session });
  }),
);

router.post(
  '/refresh',
  h(async (req, res) => {
    const { refreshToken } = parseBody(z.object({ refreshToken: z.string().min(10) }), req);
    const { userId, raw } = await tokens.rotateRefreshToken(refreshToken, meta(req));
    const user = await User.findById(userId);
    if (!user || user.status !== 'active') throw err('SESSION_EXPIRED');
    res.json({
      accessToken: tokens.signAccessToken(user),
      accessTokenExpiresIn: config.jwt.accessTtlSeconds,
      refreshToken: raw,
      tokenType: 'Bearer',
    });
  }),
);

/** Sign Out ("your records remain saved"): revokes this device's refresh token. */
router.post(
  '/sign-out',
  auth,
  h(async (req, res) => {
    const body = parseBody(z.object({ refreshToken: z.string().optional(), allDevices: z.boolean().optional() }), req);
    if (body.allDevices) await tokens.revokeAllForUser(currentUser(req)._id);
    else if (body.refreshToken) await tokens.revokeRefreshToken(body.refreshToken);
    res.json({ signedOut: true });
  }),
);

// ------------------------------------------------------------------ Password reset

/** Forgot Password → Reset Code Sent. Responds identically whether or not the account exists. */
router.post(
  '/forgot-password',
  h(async (req, res) => {
    const { identifier } = parseBody(z.object({ identifier: z.string().trim().min(3) }), req);
    const user = await findByIdentifier(identifier);
    let maskedPhone: string | null = null;
    if (user?.status === 'active') {
      await otp.sendOtp({ phone: user.phone, email: user.email, purpose: 'reset_password' });
      maskedPhone = `${user.phone.slice(0, 7)}****${user.phone.slice(-2)}`;
    } else {
      await rateLimiter.consume(`forgot:${req.ip}`, { max: 10, windowSeconds: 3600 });
    }
    res.json({
      sent: true,
      maskedPhone,
      expiresIn: config.otp.ttlSeconds,
      resendAvailableIn: config.otp.resendCooldownSeconds,
    });
  }),
);

router.post(
  '/reset-password',
  h(async (req, res) => {
    const { identifier, code, password, confirmPassword } = parseBody(
      z.object({
        identifier: z.string().trim().min(3),
        code: z.string().regex(/^\d{4,8}$/),
        password: v.password,
        confirmPassword: z.string().optional(),
      }),
      req,
    );
    if (confirmPassword !== undefined && confirmPassword !== password) {
      throw err('PASSWORD_POLICY', 'Passwords do not match.');
    }
    const user = await findByIdentifier(identifier);
    if (!user || user.status !== 'active') throw err('OTP_INVALID');
    await otp.verifyOtp({ phone: user.phone, purpose: 'reset_password', code });
    user.passwordHash = await bcrypt.hash(password, 12);
    user.passwordChangedAt = new Date();
    await user.save();
    await tokens.revokeAllForUser(user._id);
    await rateLimiter.reset(`signin:${user.phone}`);
    await rateLimiter.reset(`signin:${user.email}`);
    res.json({ reset: true });
  }),
);

export default router;
