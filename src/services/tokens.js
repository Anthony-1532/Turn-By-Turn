'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { config } = require('../config/env');
const { RefreshToken } = require('../models');
const { err } = require('../utils/errors');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function signAccessToken(user) {
  return jwt.sign({ sub: String(user._id), typ: 'access', adm: user.isAdmin ? 1 : undefined }, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessTtlSeconds,
  });
}

/** Short-lived token proving phone ownership during sign-up / password reset. */
function signSetupToken(userId, purpose) {
  return jwt.sign({ sub: String(userId), typ: 'setup', pur: purpose }, config.jwt.accessSecret, {
    expiresIn: config.jwt.setupTtlSeconds,
  });
}

function verifyJwt(token, expectedType) {
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.accessSecret);
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw err('SESSION_EXPIRED');
    throw err('UNAUTHENTICATED', 'Invalid token.');
  }
  if (payload.typ !== expectedType) throw err('UNAUTHENTICATED', 'Invalid token.');
  return payload;
}

async function issueRefreshToken(userId, { family, userAgent, ip } = {}) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const doc = await RefreshToken.create({
    userId,
    tokenHash: sha256(raw),
    family: family || crypto.randomUUID(),
    expiresAt: new Date(Date.now() + config.jwt.refreshTtlDays * 86400000),
    userAgent,
    ip,
  });
  return { raw, doc };
}

async function issueSession(user, meta = {}) {
  const { raw } = await issueRefreshToken(user._id, meta);
  return {
    accessToken: signAccessToken(user),
    accessTokenExpiresIn: config.jwt.accessTtlSeconds,
    refreshToken: raw,
    tokenType: 'Bearer',
  };
}

/** Rotate a refresh token. Presenting an already-rotated token revokes the whole family. */
async function rotateRefreshToken(raw, meta = {}) {
  const doc = await RefreshToken.findOne({ tokenHash: sha256(raw) });
  if (!doc || doc.expiresAt < new Date()) throw err('SESSION_EXPIRED');
  if (doc.revokedAt) {
    await RefreshToken.updateMany({ family: doc.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
    throw err('SESSION_EXPIRED');
  }
  const next = await issueRefreshToken(doc.userId, { family: doc.family, ...meta });
  const claimed = await RefreshToken.updateOne(
    { _id: doc._id, revokedAt: null },
    { $set: { revokedAt: new Date(), replacedBy: String(next.doc._id) } },
  );
  if (claimed.modifiedCount !== 1) {
    // Lost a race with a concurrent refresh using the same token: treat as reuse.
    await RefreshToken.updateMany({ family: doc.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
    throw err('SESSION_EXPIRED');
  }
  return { userId: doc.userId, raw: next.raw };
}

async function revokeRefreshToken(raw) {
  await RefreshToken.updateOne({ tokenHash: sha256(raw), revokedAt: null }, { $set: { revokedAt: new Date() } });
}

async function revokeAllForUser(userId) {
  await RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

module.exports = {
  sha256,
  signAccessToken,
  signSetupToken,
  verifyJwt,
  issueSession,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
};
