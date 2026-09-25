import express from 'express';
import { WebhookEvent } from '../models';
import { h } from '../middleware';
import * as squadco from '../services/squadco';
import type { PaymentOutcome, TransferOutcome } from '../services/squadco';
import * as payments from '../services/payments';
import * as payouts from '../services/payouts';

const router = express.Router();

type Json = Record<string, unknown>;
const asObject = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const asString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Squadco callbacks (payments and transfers). Mounted with express.raw so the signature is
 * checked against the exact bytes received. Every event is processed at most once, keyed by
 * event name + gateway reference.
 */
router.post(
  '/squadco',
  express.raw({ type: '*/*', limit: '1mb' }),
  h(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const signature = req.get('x-squad-encrypted-body') ?? req.get('x-squad-signature');
    if (!squadco.verifyWebhookSignature(raw, signature)) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Bad signature' } });
    }
    let payload: Json;
    try {
      payload = asObject(JSON.parse(raw));
    } catch {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON' } });
    }

    const body = asObject(payload.Body ?? payload.body ?? payload.data);
    const event = String(payload.Event ?? payload.event ?? body.event ?? '').toLowerCase();
    const reference =
      asString(payload.TransactionRef) ?? asString(body.transaction_ref) ?? asString(body.transaction_reference) ?? asString(body.reference);
    if (!reference) return res.json({ received: true, ignored: 'no reference' });

    const key = `${event}:${reference}`;
    try {
      await WebhookEvent.create({ provider: 'squadco', key, event, payload });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      const prior = await WebhookEvent.findOne({ provider: 'squadco', key });
      // Retry an event whose earlier processing crashed; ignore true duplicates.
      if (prior && prior.status !== 'error') return res.json({ received: true, duplicate: true });
    }

    try {
      const status = String(body.transaction_status ?? body.status ?? '').toLowerCase();
      if (event.includes('transfer') || event.includes('payout')) {
        // Transfer refs are sent back with the merchant prefix: strip it to find our PAY- reference.
        const ref = reference.replace(/^[^_]*_(PAY-)/, '$1');
        const outcome: TransferOutcome = status.includes('success')
          ? { status: 'sent' }
          : status.includes('fail') || status.includes('revers')
            ? { status: 'failed', failureReason: asString(body.response_description) ?? asString(body.message) ?? 'Transfer failed' }
            : { status: 'processing' };
        await payouts.applyTransferOutcome(ref, outcome);
      } else {
        let outcome: PaymentOutcome;
        if (event === 'charge_successful' || status === 'success') {
          const amount = body.amount != null ? Number(body.amount) : null;
          outcome = { status: 'success', amountKobo: Number.isFinite(amount) ? amount : null, channel: asString(body.transaction_type) };
        } else if (status === 'failed' || event.includes('fail')) {
          outcome = { status: 'failed', reason: asString(body.message) ?? 'Payment failed' };
        } else {
          outcome = { status: 'pending' };
        }
        await payments.applyPaymentOutcome(reference, outcome);
      }
      await WebhookEvent.updateOne({ provider: 'squadco', key }, { $set: { status: 'processed' }, $unset: { error: 1 } });
    } catch (e) {
      await WebhookEvent.updateOne({ provider: 'squadco', key }, { $set: { status: 'error', error: (e as Error).message } });
      throw e; // 500 → Squadco retries
    }
    return res.json({ received: true });
  }),
);

export default router;
