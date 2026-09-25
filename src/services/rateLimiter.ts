import { RateLimit } from '../models';
import { err } from '../utils/errors';

export interface LimitOptions {
  max: number;
  windowSeconds: number;
  lockSeconds?: number;
}

export interface HitResult {
  count: number;
  locked: boolean;
  retryAfter?: number;
}

/**
 * Fixed-window counter persisted in MongoDB so limits hold across Render instances and restarts.
 * Throws TOO_MANY_ATTEMPTS (with retryAfter seconds) when a key is locked.
 */
export async function assertNotLocked(key: string): Promise<void> {
  const doc = await RateLimit.findOne({ key }).lean();
  if (doc?.lockedUntil && doc.lockedUntil > new Date()) {
    const retryAfter = Math.ceil((doc.lockedUntil.getTime() - Date.now()) / 1000);
    throw err('TOO_MANY_ATTEMPTS', undefined, { retryAfter });
  }
}

/**
 * Records one hit. When `max` is exceeded inside `windowSeconds`, the key is locked for
 * `lockSeconds` (default: until the window ends).
 */
export async function hit(key: string, { max, windowSeconds, lockSeconds }: LimitOptions): Promise<HitResult> {
  const now = new Date();
  const windowStartCutoff = new Date(now.getTime() - windowSeconds * 1000);
  const ttl = Math.max(windowSeconds, lockSeconds ?? 0) + 60;

  // Reset stale windows first (only if not currently locked).
  await RateLimit.updateOne(
    { key, windowStart: { $lt: windowStartCutoff }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
    { $set: { count: 0, windowStart: now, lockedUntil: null } },
  );
  const doc = await RateLimit.findOneAndUpdate(
    { key },
    {
      $inc: { count: 1 },
      $setOnInsert: { windowStart: now },
      $set: { expiresAt: new Date(now.getTime() + ttl * 1000) },
    },
    { upsert: true, new: true },
  );

  if (doc.count > max) {
    const lockMs = (lockSeconds ?? windowSeconds) * 1000;
    const lockedUntil = doc.lockedUntil && doc.lockedUntil > now ? doc.lockedUntil : new Date(now.getTime() + lockMs);
    await RateLimit.updateOne({ key }, { $set: { lockedUntil } });
    return { count: doc.count, locked: true, retryAfter: Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000) };
  }
  return { count: doc.count, locked: false };
}

/** Hit and throw if that pushed the key over its limit. */
export async function consume(key: string, opts: LimitOptions): Promise<HitResult> {
  await assertNotLocked(key);
  const r = await hit(key, opts);
  if (r.locked) throw err('TOO_MANY_ATTEMPTS', undefined, { retryAfter: r.retryAfter });
  return r;
}

export async function reset(key: string): Promise<void> {
  await RateLimit.deleteOne({ key });
}
