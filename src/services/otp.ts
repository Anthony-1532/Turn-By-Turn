import crypto from 'crypto';
import { config } from '../config/env';
import { Otp } from '../models';
import { err } from '../utils/errors';
import { sha256 } from './tokens';
import * as rateLimiter from './rateLimiter';
import { sendSms } from './squadco';
import { sendEmail, layout } from './zeptomail';

const cfg = config.otp;

export type OtpPurpose = 'signup' | 'reset_password';

function generateCode(): string {
  if (cfg.devFixedCode) return cfg.devFixedCode;
  return String(crypto.randomInt(0, 10 ** cfg.length)).padStart(cfg.length, '0');
}

const hashCode = (target: string, purpose: OtpPurpose, code: string): string => sha256(`${purpose}:${target}:${code}`);

export interface OtpSent {
  expiresIn: number;
  resendAvailableIn: number;
}

/**
 * Sends a one-time code by SMS (Squadco), with an email copy when an address is given.
 * Enforces the resend cooldown and an hourly cap per target.
 */
export async function sendOtp({ phone, email, purpose }: { phone: string; email?: string; purpose: OtpPurpose }): Promise<OtpSent> {
  const target = phone;
  const existing = await Otp.findOne({ target, purpose });
  if (existing && !existing.consumedAt) {
    const elapsed = (Date.now() - existing.lastSentAt.getTime()) / 1000;
    if (elapsed < cfg.resendCooldownSeconds) {
      throw err('OTP_RESEND_COOLDOWN', undefined, { retryAfter: Math.ceil(cfg.resendCooldownSeconds - elapsed) });
    }
  }
  await rateLimiter.consume(`otp-send:${purpose}:${target}`, { max: config.rateLimit.otpSendMaxPerHour, windowSeconds: 3600 });

  const code = generateCode();
  const expiresAt = new Date(Date.now() + cfg.ttlSeconds * 1000);
  await Otp.findOneAndUpdate(
    { target, purpose },
    {
      $set: { codeHash: hashCode(target, purpose, code), expiresAt, attempts: 0, lastSentAt: new Date() },
      $unset: { consumedAt: 1 },
    },
    { upsert: true },
  );

  const minutes = Math.round(cfg.ttlSeconds / 60);
  const text =
    purpose === 'signup'
      ? `Your TurnByTurn verification code is ${code}. It expires in ${minutes} minutes.`
      : `Your TurnByTurn password reset code is ${code}. It expires in ${minutes} minutes. If you didn't ask for this, ignore it.`;

  await sendSms(phone, text);
  if (email) {
    sendEmail({
      to: email,
      subject: purpose === 'signup' ? 'Your TurnByTurn verification code' : 'Reset your TurnByTurn password',
      html: layout('Your code', `<p>${text}</p><p style="font-size:28px;letter-spacing:6px"><b>${code}</b></p>`),
    }).catch((e: Error) => console.error('[otp] email copy failed:', e.message));
  }
  return { expiresIn: cfg.ttlSeconds, resendAvailableIn: cfg.resendCooldownSeconds };
}

/** Verifies and consumes a code. Throws OTP_INVALID / OTP_EXPIRED / TOO_MANY_ATTEMPTS. */
export async function verifyOtp({ phone, purpose, code }: { phone: string; purpose: OtpPurpose; code: string }): Promise<true> {
  const target = phone;
  const doc = await Otp.findOne({ target, purpose });
  if (!doc || doc.consumedAt) throw err('OTP_EXPIRED');
  if (doc.attempts >= cfg.maxVerifyAttempts) throw err('TOO_MANY_ATTEMPTS', 'Too many wrong codes. Request a new code.');
  if (doc.expiresAt < new Date()) throw err('OTP_EXPIRED');

  const expected = Buffer.from(doc.codeHash);
  const given = Buffer.from(hashCode(target, purpose, String(code)));
  if (!crypto.timingSafeEqual(expected, given)) {
    const updated = await Otp.findOneAndUpdate({ _id: doc._id }, { $inc: { attempts: 1 } }, { new: true });
    const attempts = updated?.attempts ?? cfg.maxVerifyAttempts;
    if (attempts >= cfg.maxVerifyAttempts) throw err('TOO_MANY_ATTEMPTS', 'Too many wrong codes. Request a new code.');
    throw err('OTP_INVALID', undefined, { details: { attemptsRemaining: cfg.maxVerifyAttempts - attempts } });
  }
  const consumed = await Otp.updateOne({ _id: doc._id, consumedAt: null }, { $set: { consumedAt: new Date() } });
  if (consumed.modifiedCount !== 1) throw err('OTP_EXPIRED');
  return true;
}
