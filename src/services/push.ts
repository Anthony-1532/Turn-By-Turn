/** Firebase Cloud Messaging. Logs instead of sending when no service account is configured. */

import type { Messaging } from 'firebase-admin/messaging';
import { config } from '../config/env';

let messaging: Messaging | null = null;
let initialised = false;

async function getMessaging(): Promise<Messaging | null> {
  if (initialised) return messaging;
  initialised = true;
  const raw = config.firebase.serviceAccount;
  if (!raw) return null;
  try {
    const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    // Loaded lazily so deployments without Firebase never pay its startup cost.
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getMessaging: messagingFor } = await import('firebase-admin/messaging');
    messaging = messagingFor(initializeApp({ credential: cert(JSON.parse(json)) }, 'turnbyturn'));
  } catch (e) {
    console.error('[push] Failed to initialise Firebase:', (e as Error).message);
  }
  return messaging;
}

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Sends a push to every device token. Returns the tokens FCM reports as unregistered so the
 * caller can prune them.
 */
export async function sendPush(tokens: string[], { title, body, data }: PushMessage): Promise<{ invalidTokens: string[]; mocked?: true }> {
  if (!tokens.length) return { invalidTokens: [] };
  const m = await getMessaging();
  if (!m) {
    if (!config.isTest) console.info(`[push:mock] ${tokens.length} device(s) "${title}"`);
    return { invalidTokens: [], mocked: true };
  }
  const stringData = Object.fromEntries(
    Object.entries(data ?? {})
      .filter(([, v]) => v != null)
      .map(([k, v]) => [k, String(v)]),
  );
  const res = await m.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: stringData,
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  });
  const invalidTokens: string[] = [];
  res.responses.forEach((r, i) => {
    const code = r.error?.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      invalidTokens.push(tokens[i]!);
    }
  });
  return { invalidTokens };
}
