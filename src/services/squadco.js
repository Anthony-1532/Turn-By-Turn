'use strict';

/**
 * Squadco (https://docs.squadco.com) integration: payment collection, payout transfers,
 * bank account name lookup, SMS OTP and webhook signature verification.
 *
 * When SQUADCO_MOCK is on (the default when no secret key is configured) every call is
 * simulated so the Flutter team can exercise the full flow locally; see routes/dev.js.
 */

const crypto = require('crypto');
const { config } = require('../config/env');
const { err } = require('../utils/errors');
const banks = require('../content/banks.json');

const cfg = config.squadco;

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw err('GATEWAY_ERROR', undefined, { details: { cause: e.message } });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.status && Number(json.status) >= 400) || json.success === false) {
    const e = new Error(json.message || `Squadco ${method} ${path} failed with ${res.status}`);
    e.gatewayStatus = res.status;
    e.gatewayBody = json;
    throw e;
  }
  return json;
}

function bankByCode(code) {
  return banks.find((b) => b.code === code) || null;
}

// ------------------------------------------------------------------ Account name lookup

/** Resolves the registered account name for a NUBAN. Throws BANK_VERIFICATION_FAILED. */
async function resolveAccount(bankCode, accountNumber) {
  const bank = bankByCode(bankCode);
  if (!bank) throw err('BANK_VERIFICATION_FAILED', 'Select a supported bank.');
  if (!/^\d{10}$/.test(accountNumber)) throw err('BANK_VERIFICATION_FAILED', 'Account number must be 10 digits.');

  if (cfg.mock) {
    // Deterministic fake: numbers ending 000 fail, which lets the app test the error screen.
    if (accountNumber.endsWith('000')) throw err('BANK_VERIFICATION_FAILED');
    return { accountName: mockAccountName(accountNumber), bankName: bank.name, bankCode };
  }
  try {
    const json = await request('POST', '/payout/account/lookup', {
      bank_code: bankCode,
      account_number: accountNumber,
    });
    const accountName = json.data && (json.data.account_name || json.data.accountName);
    if (!accountName) throw new Error('No account name returned');
    return { accountName: accountName.trim(), bankName: bank.name, bankCode };
  } catch (e) {
    if (e.code === 'GATEWAY_ERROR') throw e;
    throw err('BANK_VERIFICATION_FAILED');
  }
}

/** Mock lookups return the name registered via setMockAccountName, else a stable placeholder. */
const mockNames = new Map();
function setMockAccountName(accountNumber, name) {
  mockNames.set(accountNumber, name);
}
function mockAccountName(accountNumber) {
  return mockNames.get(accountNumber) || `TEST ACCOUNT ${accountNumber.slice(-4)}`;
}

// ------------------------------------------------------------------ Payments

/**
 * Starts a Squadco checkout. Amount is in kobo (Squadco also works in kobo).
 * @returns {Promise<{checkoutUrl:string, gatewayReference:string}>}
 */
async function initiatePayment({ reference, amountKobo, email, customerName, metadata }) {
  if (cfg.mock) {
    return {
      checkoutUrl: `${config.publicBaseUrl}/api/v1/dev/checkout/${encodeURIComponent(reference)}`,
      gatewayReference: reference,
    };
  }
  const json = await request('POST', '/transaction/initiate', {
    amount: amountKobo,
    email,
    currency: 'NGN',
    initiate_type: 'inline',
    transaction_ref: reference,
    customer_name: customerName,
    callback_url: cfg.paymentCallbackUrl || undefined,
    pass_charge: false,
    metadata,
  }).catch((e) => {
    throw err('GATEWAY_ERROR', undefined, { details: { cause: e.message } });
  });
  return { checkoutUrl: json.data.checkout_url, gatewayReference: json.data.transaction_ref || reference };
}

/**
 * Asks Squadco for the final state of a payment.
 * @returns {Promise<{status:'success'|'failed'|'pending', amountKobo:number|null, channel?:string}>}
 */
async function verifyPayment(reference, mockState) {
  if (cfg.mock) {
    return mockState || { status: 'pending', amountKobo: null };
  }
  const json = await request('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  const d = json.data || {};
  const s = String(d.transaction_status || '').toLowerCase();
  return {
    status: s === 'success' ? 'success' : ['failed', 'abandoned', 'cancelled'].includes(s) ? 'failed' : 'pending',
    amountKobo: d.transaction_amount != null ? Number(d.transaction_amount) : null,
    channel: d.transaction_type,
  };
}

// ------------------------------------------------------------------ Payouts (transfers)

/** Squadco requires transfer references to be prefixed with the merchant id. */
function transferReference(ref) {
  return cfg.merchantId ? `${cfg.merchantId}_${ref}` : ref;
}

/**
 * @returns {Promise<{status:'sent'|'processing'|'failed', failureReason?:string}>}
 */
async function transfer({ reference, amountKobo, bankCode, accountNumber, accountName, remark }) {
  if (cfg.mock) {
    // Accounts ending 999 simulate a failed transfer so the Failed / Delayed Recovery screens can be exercised.
    if (accountNumber.endsWith('999')) return { status: 'failed', failureReason: 'Beneficiary bank unavailable' };
    return { status: 'sent' };
  }
  try {
    const json = await request('POST', '/payout/transfer', {
      transaction_reference: transferReference(reference),
      amount: String(amountKobo),
      bank_code: bankCode,
      account_number: accountNumber,
      account_name: accountName,
      currency_id: 'NGN',
      remark: (remark || 'TurnByTurn payout').slice(0, 100),
    });
    return interpretTransferStatus(json);
  } catch (e) {
    // A timeout or 5xx leaves the transfer outcome unknown: keep it processing and requery.
    if (!e.gatewayStatus || e.gatewayStatus >= 500) return { status: 'processing' };
    return { status: 'failed', failureReason: e.message };
  }
}

async function requeryTransfer(reference) {
  if (cfg.mock) return { status: 'sent' };
  try {
    const json = await request('POST', '/payout/requery', { transaction_reference: transferReference(reference) });
    return interpretTransferStatus(json);
  } catch (e) {
    if (e.gatewayStatus === 404) return { status: 'failed', failureReason: 'Transfer not found at gateway' };
    return { status: 'processing' };
  }
}

function interpretTransferStatus(json) {
  const d = json.data || {};
  const s = String(d.transaction_status || d.status || json.message || '').toLowerCase();
  if (s.includes('success') || s.includes('completed')) return { status: 'sent' };
  if (s.includes('fail') || s.includes('revers') || s.includes('declin')) {
    return { status: 'failed', failureReason: d.response_description || json.message || 'Transfer failed' };
  }
  return { status: 'processing' };
}

// ------------------------------------------------------------------ SMS

async function sendSms(phone, message) {
  if (cfg.mock) {
    if (!config.isTest) console.info(`[squadco:mock-sms] to=${phone} message="${message}"`);
    return { mocked: true };
  }
  await request('POST', '/sms/send/instant', {
    sender_id: cfg.smsSenderId,
    messages: [{ phone_number: phone.replace(/^\+/, ''), message }],
  });
  return { mocked: false };
}

// ------------------------------------------------------------------ Webhooks

/**
 * Squadco signs webhook bodies with HMAC-SHA512 of the raw body using the secret key and sends
 * the uppercase hex digest in `x-squad-encrypted-body`.
 */
function verifyWebhookSignature(rawBody, signature) {
  if (cfg.mock && !cfg.secretKey) return true;
  if (!signature || !rawBody) return false;
  const expected = crypto.createHmac('sha512', cfg.secretKey).update(rawBody).digest('hex').toUpperCase();
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature).toUpperCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  banks,
  bankByCode,
  resolveAccount,
  setMockAccountName,
  initiatePayment,
  verifyPayment,
  transfer,
  requeryTransfer,
  transferReference,
  sendSms,
  verifyWebhookSignature,
};
