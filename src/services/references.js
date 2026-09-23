'use strict';

const { Counter } = require('../models');
const { localParts } = require('../utils/dates');

/**
 * Generates unique, per-day sequential references in the app timezone, e.g. TRX-0926-0042.
 * The counter doc id includes the year so sequences never collide across years; the
 * reference itself keeps the client-specified MMDD format. When a day passes 9999 the
 * sequence simply widens (TRX-0926-10000) rather than wrapping.
 */
async function nextReference(prefix = 'TRX', date = new Date()) {
  const { year, month, day } = localParts(date);
  const mmdd = `${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  const counter = await Counter.findOneAndUpdate(
    { _id: `${prefix}-${year}${mmdd}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return `${prefix}-${mmdd}-${String(counter.seq).padStart(4, '0')}`;
}

module.exports = { nextReference };
