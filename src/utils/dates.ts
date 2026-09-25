import { config } from '../config/env';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export const FREQUENCIES = ['weekly', 'biweekly', 'monthly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface LocalParts {
  year: number;
  month: number;
  day: number;
}

/** Parts of a date in the app timezone (Africa/Lagos by default). */
export function localParts(date: Date = new Date(), timeZone: string = config.timezone): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

export function addMonthsClamped(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** Due date of cycle `n` (1-based) given the first due date and frequency. */
export function cycleDueDate(firstDueDate: Date, frequency: Frequency, n: number): Date {
  const first = new Date(firstDueDate);
  const k = n - 1;
  switch (frequency) {
    case 'weekly':
      return new Date(first.getTime() + k * 7 * 86400000);
    case 'biweekly':
      return new Date(first.getTime() + k * 14 * 86400000);
    case 'monthly':
      return addMonthsClamped(first, k);
  }
}

export function periodLabel(dueDate: Date, frequency: Frequency, n: number): string {
  if (frequency === 'monthly') return `${MONTHS[localParts(dueDate).month - 1]} cycle`;
  return `Cycle ${n}`;
}

/** YYYY-MM in the app timezone. */
export function monthKey(date: Date): string {
  const p = localParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

/** UTC range covering a YYYY-MM month in the app timezone (Lagos has no DST: fixed +01:00). */
export function monthRange(key: string): { start: Date; end: Date } {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const offsetMs = 60 * 60 * 1000;
  return { start: new Date(Date.UTC(y, m - 1, 1) - offsetMs), end: new Date(Date.UTC(y, m, 1) - offsetMs) };
}

/** Midnight today in Lagos, as a UTC instant. */
export function startOfTodayLagos(): Date {
  const p = localParts(new Date());
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - 3600000);
}
