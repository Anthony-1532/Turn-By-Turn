import * as cycles from '../services/cycles';
import * as payments from '../services/payments';
import * as payouts from '../services/payouts';
import { config } from '../config/env';

export type JobName = 'overdueCycles' | 'resolutionRequired' | 'scheduledReminders' | 'stalePayments' | 'payoutRequeries' | 'autoPayouts';
export type JobResult = number | { error: string };
export type JobReport = Partial<Record<JobName, JobResult>>;

/**
 * All scheduled work. Every task is idempotent, so overlapping runs (a Render cron job plus
 * the optional in-process scheduler) are harmless.
 */
export async function runAll(now: Date = new Date()): Promise<JobReport> {
  const tasks: Array<[JobName, () => Promise<number>]> = [
    ['overdueCycles', () => cycles.markOverdueCycles(now)],
    ['resolutionRequired', () => cycles.escalateStuckCycles(now)],
    ['scheduledReminders', () => cycles.sendScheduledReminders(now)],
    ['stalePayments', () => payments.settleStaleAttempts(24)],
    ['payoutRequeries', () => payouts.requeryInFlight(120)],
  ];
  if (config.payouts.autoStart) tasks.push(['autoPayouts', () => payouts.autoStartEligible()]);
  const result: JobReport = {};
  for (const [name, fn] of tasks) {
    try {
      result[name] = await fn();
    } catch (e) {
      console.error(`[jobs] ${name} failed:`, e);
      result[name] = { error: (e as Error).message };
    }
  }
  return result;
}

export const hasFailures = (report: JobReport): boolean =>
  Object.values(report).some((r) => typeof r === 'object' && r !== null && 'error' in r);
