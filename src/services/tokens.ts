import crypto from 'crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { config } from '../config/env';
import { RefreshToken } from '../models';
import { err } from '../utils/errors';

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

type TokenType = 'access' | 'setup';
type SetupPurpose = 'signup' | 'reset_password';

export interface TokenPayload extends JwtPayload {
  sub: string;
  typ: TokenType;
  pur?: SetupPurpose;
  adm?: 1;
}

export interface Session {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  tokenType: 'Bearer';
}

interface ClientMeta {
  userAgent?: string;
  ip?: string;
}

export function signAccessToken(user: { _id: Types.ObjectId; isAdmin?: boolean | null }): string {
  const payload: Omit<TokenPayload, 'sub'> = { typ: 'access', ...(user.isAdmin ? { adm: 1 as const } : {}) };
  return jwt.sign(payload, config.jwt.accessSecret, {
    subject: String(user._id),
    expiresIn: config.jwt.accessTtlSeconds,
  });
}

/** Short-lived token proving phone ownership during sign-up / password reset. */
export function signSetupToken(userId: Types.ObjectId, purpose: SetupPurpose): string {
  return jwt.sign({ typ: 'setup', pur: purpose }, config.jwt.accessSecret, {
    subject: String(userId),
    expiresIn: config.jwt.setupTtlSeconds,
  });
}

export function verifyJwt(token: string, expectedType: TokenType): TokenPayload {
  let payload: string | JwtPayload;
  try {
    payload = jwt.verify(token, config.jwt.accessSecret);
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) throw err('SESSION_EXPIRED');
    throw err('UNAUTHENTICATED', 'Invalid token.');
  }
  if (typeof payload === 'string' || payload.typ !== expectedType || typeof payload.sub !== 'string') {
    throw err('UNAUTHENTICATED', 'Invalid token.');
  }
  return payload as TokenPayload;
}

async function issueRefreshToken(userId: Types.ObjectId, meta: ClientMeta & { family?: string } = {}) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const doc = await RefreshToken.create({
    userId,
    tokenHash: sha256(raw),
    family: meta.family ?? crypto.randomUUID(),
    expiresAt: new Date(Date.now() + config.jwt.refreshTtlDays * 86400000),
    userAgent: meta.userAgent,
    ip: meta.ip,
  });
  return { raw, doc };
}

export async function issueSession(
  user: { _id: Types.ObjectId; isAdmin?: boolean | null },
  meta: ClientMeta = {},
): Promise<Session> {
  const { raw } = await issueRefreshToken(user._id, meta);
  return {
    accessToken: signAccessToken(user),
    accessTokenExpiresIn: config.jwt.accessTtlSeconds,
    refreshToken: raw,
    tokenType: 'Bearer',
  };
}

/** Rotate a refresh token. Presenting an already-rotated token revokes the whole family. */
export async function rotateRefreshToken(raw: string, meta: ClientMeta = {}): Promise<{ userId: Types.ObjectId; raw: string }> {
  const doc = await RefreshToken.findOne({ tokenHash: sha256(raw) });
  if (!doc || doc.expiresAt < new Date()) throw err('SESSION_EXPIRED');
  const revokeFamily = () =>
    RefreshToken.updateMany({ family: doc.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (doc.revokedAt) {
    await revokeFamily();
    throw err('SESSION_EXPIRED');
  }
  const next = await issueRefreshToken(doc.userId, { family: doc.family, ...meta });
  const claimed = await RefreshToken.updateOne(
    { _id: doc._id, revokedAt: null },
    { $set: { revokedAt: new Date(), replacedBy: String(next.doc._id) } },
  );
  if (claimed.modifiedCount !== 1) {
    // Lost a race with a concurrent refresh using the same token: treat as reuse.
    await revokeFamily();
    throw err('SESSION_EXPIRED');
  }
  return { userId: doc.userId, raw: next.raw };
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  await RefreshToken.updateOne({ tokenHash: sha256(raw), revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export async function revokeAllForUser(userId: Types.ObjectId): Promise<void> {
  await RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}
