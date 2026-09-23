'use strict';

const cycles = require('../services/cycles');
const payments = require('../services/payments');
const payouts = require('../services/payouts');
const { config } = require('../config/env');

/**
 * All scheduled work. Every task is idempotent, so overlapping runs (a Render cron job plus
 * the optional in-process scheduler) are harmless.
 */
async function runAll(now = new Date()) {
  const result = {};
  const tasks = [
    ['overdueCycles', () => cycles.markOverdueCycles(now)],
    ['resolutionRequired', () => cycles.escalateStuckCycles(now)],
    ['scheduledReminders', () => cycles.sendScheduledReminders(now)],
    ['stalePayments', () => payments.settleStaleAttempts(24)],
    ['payoutRequeries', () => payouts.requeryInFlight(120)],
  ];
  if (config.payouts.autoStart) tasks.push(['autoPayouts', () => payouts.autoStartEligible()]);
  for (const [name, fn] of tasks) {
    try {
      result[name] = await fn();
    } catch (e) {
      console.error(`[jobs] ${name} failed:`, e);
      result[name] = { error: e.message };
    }
  }
  return result;
}

module.exports = { runAll };
