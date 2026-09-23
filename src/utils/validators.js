'use strict';

const { z } = require('zod');

/** Accepts 08012345678, 8012345678, 2348012345678, +234 801 234 5678 → +2348012345678. */
function normalisePhone(input) {
  const digits = String(input || '').replace(/[^\d+]/g, '');
  let d = digits.replace(/^\+/, '');
  if (d.startsWith('234')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  if (!/^[789]\d{9}$/.test(d)) return null;
  return `+234${d}`;
}

const phone = z
  .string()
  .transform((v, ctx) => {
    const p = normalisePhone(v);
    if (!p) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid Nigerian phone number' });
      return z.NEVER;
    }
    return p;
  });

const email = z.string().trim().toLowerCase().email('Enter a valid email address');

const PASSWORD_RULES = [
  'At least 8 characters',
  'At least one letter',
  'At least one number',
];

const password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Use at most 128 characters')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number');

/** Money input in kobo (integer). */
const kobo = z.number().int('Amount must be in kobo (whole number)').positive('Amount must be greater than zero');

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const name = z.string().trim().min(2, 'Enter your full name').max(80);

function passwordStrength(pw) {
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  return score <= 2 ? 'weak' : score <= 3 ? 'medium' : 'strong';
}

module.exports = { z, normalisePhone, phone, email, password, PASSWORD_RULES, kobo, objectId, name, passwordStrength };
