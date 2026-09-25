/**
 * Development-only helpers (mounted when ENABLE_DEV_ROUTES is on, never in production by
 * default). They stand in for the Squadco hosted checkout while SQUADCO_MOCK is enabled.
 */

import express from 'express';
import { PaymentAttempt } from '../models';
import { h, param, parseBody } from '../middleware';
import { err } from '../utils/errors';
import { z } from '../utils/validators';
import * as payments from '../services/payments';
import type { PaymentOutcome } from '../services/squadco';
import { runAll } from '../jobs/tasks';

const router = express.Router();

/** Minimal fake checkout page so the app's WebView has something to load. */
router.get(
  '/checkout/:reference',
  h(async (req, res) => {
    const a = await PaymentAttempt.findOne({ reference: param(req, 'reference') });
    if (!a) throw err('NOT_FOUND');
    const ref = encodeURIComponent(a.reference);
    res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width">
<body style="font-family:sans-serif;padding:24px"><h3>Mock Squadco checkout</h3>
<p>Reference ${a.reference}<br>Total ₦${(a.totalCharged / 100).toLocaleString()}</p>
<form method="post" action="/api/v1/dev/payments/${ref}/complete"><button>Pay (success)</button></form>
<form method="post" action="/api/v1/dev/payments/${ref}/complete?fail=1"><button>Fail payment</button></form></body>`);
  }),
);

/**
 * Simulates the gateway confirming a payment (the same code path as the webhook).
 * Optional `amount` (kobo) simulates the gateway confirming a different total, e.g. an
 * overpayment for the Reconciliation Required flow.
 */
router.post(
  '/payments/:reference/complete',
  express.urlencoded({ extended: false }),
  h(async (req, res) => {
    const { amount } = parseBody(z.object({ amount: z.coerce.number().int().positive().optional() }).passthrough(), req);
    const a = await PaymentAttempt.findOne({ reference: param(req, 'reference') });
    if (!a) throw err('NOT_FOUND');
    const outcome: PaymentOutcome = req.query.fail
      ? { status: 'failed', reason: 'Declined (mock)' }
      : { status: 'success', amountKobo: amount ?? a.totalCharged, channel: 'mock' };
    const attempt = await payments.applyPaymentOutcome(a.reference, outcome);
    res.json({ payment: attempt?.toJSON() ?? null });
  }),
);

/** Runs every scheduled job immediately (handy while testing overdue / reminder flows). */
router.post(
  '/jobs/run',
  h(async (_req, res) => {
    res.json(await runAll());
  }),
);

export default router;
