import { config } from '../config/env';

/**
 * All money is stored and computed as integer kobo (1 NGN = 100 kobo). The alias documents
 * intent at every signature that takes or returns money.
 */
export type Kobo = number;

export interface FeeBreakdown {
  contribution: Kobo;
  serviceFee: Kobo;
  total: Kobo;
  feePercent: number;
}

export function assertKobo(n: number, field = 'amount'): Kobo {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`${field} must be a non-negative integer number of kobo`);
  }
  return n;
}

/** Platform fee on top of an amount, rounded half-up to the nearest kobo. */
export function feeFor(amount: Kobo, bps: number = config.money.platformFeeBps): Kobo {
  assertKobo(amount);
  return Math.floor((amount * bps + 5000) / 10000);
}

export function breakdown(amount: Kobo, bps: number = config.money.platformFeeBps): FeeBreakdown {
  const fee = feeFor(amount, bps);
  return { contribution: amount, serviceFee: fee, total: amount + fee, feePercent: bps / 100 };
}

export function formatNaira(kobo: Kobo): string {
  const naira = kobo / 100;
  return `₦${naira.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
