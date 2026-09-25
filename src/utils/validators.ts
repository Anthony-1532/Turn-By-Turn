import { z } from 'zod';

export { z };

/** Accepts 08012345678, 8012345678, 2348012345678, +234 801 234 5678 → +2348012345678. */
export function normalisePhone(input: unknown): string | null {
  const digits = String(input ?? '').replace(/[^\d+]/g, '');
  let d = digits.replace(/^\+/, '');
  if (d.startsWith('234')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  if (!/^[789]\d{9}$/.test(d)) return null;
  return `+234${d}`;
}

export const phone = z.string().transform((v, ctx) => {
  const p = normalisePhone(v);
  if (!p) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid Nigerian phone number' });
    return z.NEVER;
  }
  return p;
});

export const email = z.string().trim().toLowerCase().email('Enter a valid email address');

export const PASSWORD_RULES = ['At least 8 characters', 'At least one letter', 'At least one number'] as const;

export const password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Use at most 128 characters')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number');

/** Money input in kobo (integer). */
export const kobo = z.number().int('Amount must be in kobo (whole number)').positive('Amount must be greater than zero');

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

export const name = z.string().trim().min(2, 'Enter your full name').max(80);

export type PasswordStrength = 'weak' | 'medium' | 'strong';

export function passwordStrength(pw: string): PasswordStrength {
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  return score <= 2 ? 'weak' : score <= 3 ? 'medium' : 'strong';
}

export const isObjectId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
