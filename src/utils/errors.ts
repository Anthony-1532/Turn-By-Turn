/**
 * Every error the API returns has a stable machine-readable `code`. The Flutter app maps
 * these codes to the dedicated error screens in the design (see docs/ERRORS.md).
 */
export const ErrorCodes = {
  // Generic
  VALIDATION_ERROR: { status: 400, message: 'Some fields are invalid.' },
  NOT_FOUND: { status: 404, message: 'Not found.' },
  CONFLICT: { status: 409, message: 'The request conflicts with the current state.' },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong. Please try again.' },
  GATEWAY_ERROR: { status: 502, message: 'Our payment partner is unavailable. Please try again.' },

  // Auth screens
  INVALID_CREDENTIALS: { status: 401, message: 'Phone/email or password is incorrect.' },
  OTP_INVALID: { status: 400, message: 'That code is not correct.' },
  OTP_EXPIRED: { status: 400, message: 'That code has expired. Request a new one.' },
  OTP_RESEND_COOLDOWN: { status: 429, message: 'Please wait before requesting another code.' },
  PASSWORD_POLICY: { status: 422, message: 'Password does not meet the requirements.' },
  ACCOUNT_EXISTS: { status: 409, message: 'An account already exists with this phone or email.' },
  TOO_MANY_ATTEMPTS: { status: 429, message: 'Too many attempts. Please try again later.' },
  BANK_VERIFICATION_FAILED: { status: 422, message: 'We could not verify this bank account.' },
  SESSION_EXPIRED: { status: 401, message: 'Your session has expired. Please sign in again.' },
  UNAUTHENTICATED: { status: 401, message: 'Please sign in.' },
  ACCESS_DENIED: { status: 403, message: 'You do not have access to this.' },
  SIGNUP_INCOMPLETE: { status: 409, message: 'Finish creating your account first.' },

  // Groups
  GROUP_NOT_DRAFT: { status: 409, message: 'This group has started; amount and turn order are locked.' },
  GROUP_NOT_ACTIVE: { status: 409, message: 'This group is not active.' },
  GROUP_SETUP_INCOMPLETE: { status: 422, message: 'Group setup is not complete.' },
  GROUP_FULL: { status: 409, message: 'This group has no open places.' },
  INVITE_INVALID: { status: 404, message: 'That invite code or link is not valid.' },
  ALREADY_MEMBER: { status: 409, message: 'You are already in this group.' },

  // Money
  AMOUNT_INVALID: { status: 422, message: 'Enter a valid amount.' },
  NOTHING_DUE: { status: 409, message: 'Nothing is due for this cycle.' },
  CYCLE_CLOSED: { status: 409, message: 'This cycle is no longer accepting payments.' },
  PAYOUT_NOT_ELIGIBLE: { status: 409, message: 'This payout cannot be started yet.' },
  PAYOUT_ACCOUNT_MISSING: { status: 409, message: 'The recipient has no verified payout account.' },
  REMINDER_COOLDOWN: { status: 429, message: 'These members were reminded recently.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ErrorCodes;

export interface ApiErrorExtra {
  details?: unknown;
  retryAfter?: number;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryAfter?: number;

  constructor(code: ErrorCode, message?: string, extra: ApiErrorExtra = {}) {
    const def = ErrorCodes[code];
    super(message ?? def.message);
    this.name = 'ApiError';
    this.code = code;
    this.status = def.status;
    this.details = extra.details;
    this.retryAfter = extra.retryAfter;
  }
}

export const err = (code: ErrorCode, message?: string, extra?: ApiErrorExtra): ApiError =>
  new ApiError(code, message, extra);
