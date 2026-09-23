'use strict';

const { RateLimit } = require('../models');
const { err } = require('../utils/errors');

/**
 * Fixed-window counter persisted in MongoDB so limits hold across Render instances and restarts.
 * Throws TOO_MANY_ATTEMPTS (with retryAfter seconds) when a key is locked.
 */
async function assertNotLocked(key) {
  const doc = await RateLimit.findOne({ key }).lean();
  if (doc && doc.lockedUntil && doc.lockedUntil > new Date()) {
    const retryAfter = Math.ceil((doc.lockedUntil - Date.now()) / 1000);
    throw err('TOO_MANY_ATTEMPTS', undefined, { retryAfter });
  }
}

/**
 * Records one hit. When `max` is exceeded inside `windowSeconds`, the key is locked for
 * `lockSeconds` (default: until the window ends).
 * @returns {Promise<{count:number, locked:boolean, retryAfter?:number}>}
 */
async function hit(key, { max, windowSeconds, lockSeconds }) {
  const now = new Date();
  const windowStartCutoff = new Date(now.getTime() - windowSeconds * 1000);
  const ttl = Math.max(windowSeconds, lockSeconds || 0) + 60;

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
    const lockMs = (lockSeconds || windowSeconds) * 1000;
    const lockedUntil = doc.lockedUntil && doc.lockedUntil > now ? doc.lockedUntil : new Date(now.getTime() + lockMs);
    await RateLimit.updateOne({ key }, { $set: { lockedUntil } });
    return { count: doc.count, locked: true, retryAfter: Math.ceil((lockedUntil - now) / 1000) };
  }
  return { count: doc.count, locked: false };
}

/** Hit and throw if that pushed the key over its limit. */
async function consume(key, opts) {
  await assertNotLocked(key);
  const r = await hit(key, opts);
  if (r.locked) throw err('TOO_MANY_ATTEMPTS', undefined, { retryAfter: r.retryAfter });
  return r;
}

async function reset(key) {
  await RateLimit.deleteOne({ key });
}

module.exports = { assertNotLocked, hit, consume, reset };
