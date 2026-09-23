'use strict';

/** Firebase Cloud Messaging. Logs instead of sending when no service account is configured. */

const { config } = require('../config/env');

let messaging = null;
let initialised = false;

function getMessaging() {
  if (initialised) return messaging;
  initialised = true;
  const raw = config.firebase.serviceAccount;
  if (!raw) return null;
  try {
    const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const admin = require('firebase-admin');
    const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(json)) }, 'turnbyturn');
    messaging = app.messaging();
  } catch (e) {
    console.error('[push] Failed to initialise Firebase:', e.message);
  }
  return messaging;
}

/**
 * Sends a push to every device token. Returns the tokens FCM reports as unregistered so the
 * caller can prune them.
 */
async function sendPush(tokens, { title, body, data }) {
  if (!tokens.length) return { invalidTokens: [] };
  const m = getMessaging();
  if (!m) {
    if (!config.isTest) console.info(`[push:mock] ${tokens.length} device(s) "${title}"`);
    return { invalidTokens: [], mocked: true };
  }
  const stringData = Object.fromEntries(
    Object.entries(data || {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
  );
  const res = await m.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: stringData,
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  });
  const invalidTokens = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      invalidTokens.push(tokens[i]);
    }
  });
  return { invalidTokens };
}

module.exports = { sendPush };
