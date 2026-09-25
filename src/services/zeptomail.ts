/** Zeptomail (Zoho) transactional email. Logs instead of sending when no token is configured. */

import { config } from '../config/env';

const cfg = config.zeptomail;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

export function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f5f6f8;padding:24px">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;padding:24px">
<h2 style="margin-top:0;color:#0f172a">${escapeHtml(title)}</h2>${bodyHtml}
<p style="color:#64748b;font-size:12px;margin-top:32px">TurnByTurn — One group. One clear turn.</p>
</div></body></html>`;
}

export interface EmailInput {
  to: string | undefined | null;
  toName?: string;
  subject: string;
  html?: string;
  text?: string;
}

export async function sendEmail({ to, toName, subject, html, text }: EmailInput): Promise<{ skipped?: true; mocked?: boolean }> {
  if (!to) return { skipped: true };
  if (!cfg.token) {
    if (!config.isTest) console.info(`[zeptomail:mock] to=${to} subject="${subject}"`);
    return { mocked: true };
  }
  const authHeader = cfg.token.startsWith('Zoho-enczapikey') ? cfg.token : `Zoho-enczapikey ${cfg.token}`;
  const res = await fetch(cfg.baseUrl, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      from: { address: cfg.fromAddress, name: cfg.fromName },
      to: [{ email_address: { address: to, name: toName ?? to } }],
      subject,
      htmlbody: html ?? layout(subject, `<p>${escapeHtml(text ?? '')}</p>`),
      textbody: text,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Zeptomail send failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return { mocked: false };
}
