'use strict';

const { config } = require('../config/env');

/** All money is stored and computed as integer kobo (1 NGN = 100 kobo). */

function assertKobo(n, field = 'amount') {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`${field} must be a non-negative integer number of kobo`);
  }
  return n;
}

/** Platform fee on top of an amount, rounded half-up to the nearest kobo. */
function feeFor(amountKobo, bps = config.money.platformFeeBps) {
  assertKobo(amountKobo);
  return Math.floor((amountKobo * bps + 5000) / 10000);
}

function breakdown(amountKobo, bps = config.money.platformFeeBps) {
  const fee = feeFor(amountKobo, bps);
  return { contribution: amountKobo, serviceFee: fee, total: amountKobo + fee, feePercent: bps / 100 };
}

function formatNaira(kobo) {
  const naira = kobo / 100;
  return `₦${naira.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

module.exports = { assertKobo, feeFor, breakdown, formatNaira };
