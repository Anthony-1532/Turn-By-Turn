# Error codes → screens

Every error response has the same shape:

```json
{
  "error": {
    "code": "TOO_MANY_ATTEMPTS",
    "message": "Too many attempts. Please try again later.",
    "retryAfter": 840,
    "details": {}
  }
}
```

Branch on `code`, never on `message` (messages are human copy and may change). `retryAfter`
(seconds) is also sent as a `Retry-After` header. `details` is optional and code-specific.

## Error screens from the design

| Screen | `code` | HTTP | Returned by | Notes |
|---|---|---|---|---|
| Invalid credentials | `INVALID_CREDENTIALS` | 401 | `POST /auth/sign-in`, `POST /users/me/password` | `details.attemptsRemaining` before lockout |
| Verification code error | `OTP_INVALID` | 400 | `POST /auth/verify-otp`, `POST /auth/reset-password` | `details.attemptsRemaining` |
| Verification code error (expired) | `OTP_EXPIRED` | 400 | same | Offer "Resend code" |
| Resend cooldown | `OTP_RESEND_COOLDOWN` | 429 | `POST /auth/signup`, `/auth/resend-otp`, `/auth/forgot-password` | Drive the countdown from `retryAfter` |
| Password validation error | `PASSWORD_POLICY` | 422 | `POST /auth/set-password`, `/auth/reset-password`, `/users/me/password` | `details[]` lists each failed rule |
| Account already exists | `ACCOUNT_EXISTS` | 409 | `POST /auth/signup`, `/auth/set-password` | `details.field` = `phone` or `email` |
| Too many attempts | `TOO_MANY_ATTEMPTS` | 429 | sign-in, OTP verify/send, forgot-password | Server-side lockout persisted in MongoDB; `retryAfter` |
| Bank verification error | `BANK_VERIFICATION_FAILED` | 422 | `POST /users/me/bank-account/resolve`, `PUT /users/me/bank-account` | Squadco name lookup failed |
| Session expired | `SESSION_EXPIRED` | 401 | any authenticated route, `POST /auth/refresh` | Try `/auth/refresh` once; if that also returns `SESSION_EXPIRED`, go to Sign In |
| Access denied | `ACCESS_DENIED` | 403 | group/coordinator/admin routes | e.g. a member calling a coordinator-only endpoint |
| Offline / retry | — | — | — | Client-side. Payment initiation is safe to retry; webhooks and `/payments/:ref/verify` are idempotent |
| No groups | — | 200 | `GET /groups` | `{"groups": []}`: an empty state, not an error |

## Other codes

| `code` | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query failed validation. `details[] = {field, message}` |
| `UNAUTHENTICATED` | 401 | No/invalid bearer token |
| `NOT_FOUND` | 404 | Resource or route not found |
| `CONFLICT` | 409 | State changed underneath the request (refresh and retry) |
| `SIGNUP_INCOMPLETE` | 409 | Setup token used for an account that is not at the password step |
| `GROUP_NOT_DRAFT` | 409 | Tried to edit amount / members / turn order after activation |
| `GROUP_NOT_ACTIVE` | 409 | Action needs an active group (e.g. reminders) |
| `GROUP_SETUP_INCOMPLETE` | 422 | Activation blocked. `details.missing[]` names the unfinished steps |
| `GROUP_FULL` | 409 | No open place (or the group already started) |
| `INVITE_INVALID` | 404 | Unknown or completed group invite code |
| `ALREADY_MEMBER` | 409 | Joining a group you're already in. `details.groupId` |
| `AMOUNT_INVALID` | 422 | Payment amount above what's owed / below the part-payment minimum |
| `NOTHING_DUE` | 409 | Contribution already fully paid |
| `CYCLE_CLOSED` | 409 | Cycle is complete and no longer takes payments |
| `PAYOUT_NOT_ELIGIBLE` | 409 | Payout isn't in a state that allows this action |
| `PAYOUT_ACCOUNT_MISSING` | 409 | Recipient has no verified bank account |
| `REMINDER_COOLDOWN` | 429 | Every selected member was reminded within `REMINDER_COOLDOWN_HOURS`. `details.skipped[]` |
| `GATEWAY_ERROR` | 502 | Squadco unavailable, so try again |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
