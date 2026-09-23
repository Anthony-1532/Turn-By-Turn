'use strict';

const { config } = require('../config/env');

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Parts of a date in the app timezone (Africa/Lagos by default). */
function localParts(date = new Date(), timeZone = config.timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function addMonthsClamped(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

const FREQUENCIES = ['weekly', 'biweekly', 'monthly'];

/** Due date of cycle `n` (1-based) given the first due date and frequency. */
function cycleDueDate(firstDueDate, frequency, n) {
  const first = new Date(firstDueDate);
  const k = n - 1;
  if (frequency === 'weekly') return new Date(first.getTime() + k * 7 * 86400000);
  if (frequency === 'biweekly') return new Date(first.getTime() + k * 14 * 86400000);
  if (frequency === 'monthly') return addMonthsClamped(first, k);
  throw new Error(`Unknown frequency ${frequency}`);
}

function periodLabel(dueDate, frequency, n) {
  if (frequency === 'monthly') return `${MONTHS[localParts(dueDate).month - 1]} cycle`;
  return `Cycle ${n}`;
}

function monthKey(date) {
  const p = localParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** UTC range covering a YYYY-MM month in the app timezone (Lagos has no DST: fixed +01:00). */
function monthRange(key) {
  const [y, m] = key.split('-').map(Number);
  const offsetMs = 60 * 60 * 1000;
  const start = new Date(Date.UTC(y, m - 1, 1) - offsetMs);
  const end = new Date(Date.UTC(y, m, 1) - offsetMs);
  return { start, end };
}

module.exports = {
  FREQUENCIES, cycleDueDate, periodLabel, localParts, monthKey, monthLabel, monthRange, addMonthsClamped,
};
