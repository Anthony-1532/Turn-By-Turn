# TurnByTurn API

Backend for **TurnByTurn**, a rotating savings and credit association (ajo / esusu) app for Nigeria.
*One group. One clear turn.*

A coordinator creates a group, members contribute a fixed amount every cycle, and each cycle the
whole pot goes to the next member in a locked turn order until everyone has been paid once.
This service backs the Flutter app (Android and iOS) and the Vercel marketing site.

| Concern | Service |
|---|---|
| Hosting | Render (web service + cron job, see `render.yaml`) |
| Database | MongoDB (Mongoose) |
| Payments, payouts, bank-name lookup, SMS OTP | Squadco |
| Email | Zeptomail |
| Push | Firebase Cloud Messaging |

Runtime: **TypeScript** (strict mode) on Node.js 20+ and Express 4, with JWT access tokens and rotating refresh tokens. Source lives in `src/` and compiles to `dist/`.

---

## Quick start

```bash
cp .env.example .env          # only MONGODB_URI is required locally
npm install
npm run seed                  # fixture data (wipes the target DB)
npm run dev                   # http://localhost:4000 (tsx watch, no build step)
```

| Script | What it does |
|---|---|
| `npm run dev` | Run from source with reload (`tsx watch src/server.ts`) |
| `npm run build` | Compile `src/` → `dist/` (`tsc -p tsconfig.build.json`) |
| `npm start` | Run the compiled server (`node dist/server.js`) |
| `npm run typecheck` | Type-check `src/`, `test/` and `scripts/` (strict) |
| `npm test` | End-to-end tests (`node --test` via `tsx`) |
| `npm run jobs` / `jobs:dev` | Scheduled jobs from `dist/` / from source |
| `npm run seed` | Load fixture data (wipes the target DB) |
| `npm run docs` | Regenerate `docs/openapi.json` |

* API docs: [`docs/API.md`](docs/API.md) (endpoint reference), `http://localhost:4000/api/v1/docs` (Swagger UI) or `/api/v1/openapi.json` (import into Postman)
* Health check: `GET /health`
* Tests: `npm test` (needs a local MongoDB; override with `TEST_MONGODB_URI`)
* Regenerate the OpenAPI spec after changing routes: `npm run docs`

### Seed data

`npm run seed` creates:

* **Unity Women's Ajo**: ₦50,000 × 10 members, monthly, 2% fee. Cycle 1 is fully paid and its payout
  has been sent. Cycle 2 is in progress: 6 members paid, 1 part-paid, 1 overpaid (Reconciliation
  Required) and 2 unpaid.
* **Family Circle**: ₦20,000 × 4, weekly. The Unity coordinator (Ngozi Okafor, `+2348031000001`) is a
  plain **member** here, which shows that roles are per group.
* **Office Savings Club**: a draft group partway through setup.
* An admin/staff account, `support@turnbyturn.app`.

Every seeded account uses the password `Password123`.

### Mock mode (no credentials needed)

With no `SQUADCO_SECRET_KEY` set, every Squadco call is simulated, so the Flutter team can run every
flow end to end:

* **OTP**: the SMS is logged to the console. Set `OTP_DEV_FIXED_CODE=123456` to make every code `123456`
  (this is ignored in production).
* **Checkout**: `checkoutUrl` points to `/api/v1/dev/checkout/:reference`, a small page with Pay and Fail
  buttons. `POST /api/v1/dev/payments/:reference/complete` does the same thing; send `{"amount": <kobo>}`
  to simulate the gateway confirming a different amount, such as an overpayment.
* **Bank lookup**: account numbers ending in `000` fail verification, which exercises the Bank
  Verification Error screen.
* **Transfers**: accounts ending in `999` fail, which exercises the Payout Failed and Delayed Recovery
  screens.
* **Jobs**: `POST /api/v1/dev/jobs/run` runs the scheduled jobs immediately.
* **Email and push**: logged to the console until `ZEPTOMAIL_TOKEN` and `FIREBASE_SERVICE_ACCOUNT` are set.

---

## Conventions for the app

* **Money is always integer kobo** (₦50,000 is `5000000`). Format to Naira only in the UI.
* **Errors** always have the shape `{ "error": { "code", "message", "details?", "retryAfter?" } }`.
  Branch on `code`. [`docs/ERRORS.md`](docs/ERRORS.md) maps each code to its error screen
  (Invalid credentials, Verification code error, Password validation error, Account already exists,
  Too many attempts, Bank verification error, Session expired, Access denied, …).
* **Auth**: send `Authorization: Bearer <accessToken>`. Access tokens last 15 minutes. When a request
  returns `SESSION_EXPIRED`, call `POST /auth/refresh` once. If that also returns `SESSION_EXPIRED`,
  send the user to Sign In. Refresh tokens rotate, and reusing an old one revokes that whole login.
* **Phones** can be sent in any Nigerian format (`0803…`, `+234…`). They are stored as E.164.
* **Empty states** are successful responses (`GET /groups` returns `{"groups": []}`), not errors.
* **Roles are per group.** Every group response includes `viewerRole` (`coordinator` | `member`).

## Screen → endpoint map (all under `/api/v1`)

| Flow | Endpoints |
|---|---|
| Create Account → Verify Contact → Create Password | `POST /auth/signup`, `/auth/resend-otp`, `/auth/verify-otp`, `/auth/set-password` (`/auth/password-strength` for live guidance) |
| Payout Account → Account Verified | `GET /banks`, `POST /users/me/bank-account/resolve`, `PUT /users/me/bank-account` |
| Sign In / Forgot / Reset | `POST /auth/sign-in`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/refresh`, `/auth/sign-out` |
| Join Group (3 steps) | `POST /groups/join/preview` → `POST /groups/join` |
| Create Group (5 steps) → Activated | `POST /groups` → `PATCH /groups/:id/draft` → `POST /groups/:id/members` → `PUT /groups/:id/payout-order` → `GET /groups/:id/review` → `POST /groups/:id/activate` |
| Home / Returning Home | `GET /home` |
| Group Overview, Members, Info, Announcements, Activity | `GET /groups/:id`, `/members`, `/info`, `/announcements`, `/activity` |
| Payment Status / Who Has Paid / Cycle Progress / Cycle Overdue | `GET /groups/:id/payment-status`, `/groups/:id/cycles/current` |
| Pay (full or part) → Review → checkout | `GET /cycles/:id/my-contribution`, `GET /cycles/:id/contributions/quote?amount=`, `POST /cycles/:id/contributions`, then `POST /payments/:ref/verify` |
| Payment received / Receipts | `GET /payments/:ref/receipt`, `GET /receipts` |
| Reconciliation Required → Review Submitted | `POST /contributions/:id/reconcile` |
| Resolution Required → Contact support | `POST /cycles/:id/support` |
| Payout Blocked / Eligible / Processing / Sent / Failed / Delayed Recovery | `GET /payouts/:id`, `POST /payouts/:id/start` |
| Coordinator: Manage Group, Member Detail, Invite, Reminders, Settings, Turn Order | `GET /groups/:id/dashboard`, `/members/:membershipId`, `/invite`, `POST /groups/:id/reminders`, `PATCH /groups/:id/settings`, `GET /groups/:id/payout-order` |
| History + Filter + Details | `GET /transactions?month=&status=&type=&groupId=`, `/transactions/filters`, `/transactions/:id` |
| Notifications | `GET /notifications`, `POST /notifications/read`, `POST /users/me/devices` (FCM token) |
| Profile | `GET/PATCH /users/me`, `PUT /users/me/photo` (multipart `photo`), `/users/me/trusted-contact`, `/users/me/notification-preferences`, `POST /users/me/password` |
| Payment Help | `GET /content/help` |

The full reference is in the OpenAPI spec.

---

## How the money works

```
Group (draft) ──activate──▶ Group (active) ──last payout sent──▶ Group (completed)
                               │
                               ▼
Cycle n: open ──fully funded──▶ complete ──▶ opens Cycle n+1
           │
           └─ due + grace ──▶ overdue ──+7 days──▶ resolution_required (manual; staff resolve)

Payout: blocked ──cycle complete──▶ eligible ──Start payout──▶ processing ──▶ sent
                                                                  └──▶ failed ──staff retry──▶ delayed_recovery ──▶ sent
```

* **Fee**: 2% (`PLATFORM_FEE_BPS=200`) is added on top of every payment and recorded as its own `fee`
  ledger row. It is never deducted from payouts. A ₦50,000 cycle payment costs ₦51,000.
* **Custody**: members pay through Squadco checkout into platform custody, not to the coordinator.
  Payouts are Squadco transfers to the recipient's verified bank account.
* **Partial payments**: any amount from `MIN_PARTIAL_PAYMENT_KOBO` up to the outstanding balance.
  Each checkout is a `PaymentAttempt` with its own `TRX-MMDD-####` reference and receipt.
* **Idempotency**: the webhook, the app's `/payments/:ref/verify` call and the stale-payment job all
  go through `applyPaymentOutcome`. It atomically claims the pending attempt, so each payment is
  credited once however many times the gateway retries. Webhook events are also logged in
  `webhookevents`, keyed by event and reference.
* **Overpayment**: if the gateway confirms more than was charged, or concurrent payments exceed the
  amount owed, the contribution is capped at `amountDue` and the excess is flagged
  (`reconciliation_required`). The original transaction row keeps exactly what was received. The member
  submits it for review, and staff close it with `refunded`, `credited` or `dismissed`, which appends a
  `refund` or `adjustment` row. Nothing is resolved automatically.
* **Stuck cycles**: the MVP has no automatic cancellation, replacement, refund or voting. After
  `CYCLE_RESOLUTION_AFTER_DAYS` overdue, a support ticket is opened. Staff use
  `POST /admin/cycles/:id/resolve` with `extend_deadline`, `release` (pay out what was collected) or `note`.
* **Audit trail**: `Contribution`, `PaymentAttempt`, `Payout` and `Transaction` block deletes at the
  model level. Corrections are new rows.
* **History indexes**: `userId+createdAt`, `userId+status+createdAt`, `userId+type+createdAt`,
  `userId+groupId+createdAt` and `groupId+status`.

### Scheduled jobs (`npm run jobs`, every 10 minutes on Render cron)

| Job | What it does |
|---|---|
| overdueCycles | `open` → `overdue` once `dueDate + CYCLE_OVERDUE_GRACE_HOURS` has passed; notifies members who still owe and the coordinator |
| resolutionRequired | `overdue` → `resolution_required` after `CYCLE_RESOLUTION_AFTER_DAYS`; opens a support ticket |
| scheduledReminders | Nudges unpaid members `AUTO_REMINDER_DAYS_BEFORE` days before the due date (once per threshold) |
| stalePayments | Checks pending checkouts older than 24h with Squadco, then marks them abandoned |
| payoutRequeries | Re-queries transfers whose outcome is still unknown |
| autoPayouts | Only when `AUTO_START_PAYOUTS=true`: releases eligible payouts automatically |

All jobs are idempotent. You can also trigger them with `POST /api/v1/internal/jobs/run` and the
`x-cron-secret` header, or run them in-process with `ENABLE_INPROCESS_JOBS=true`.

### Coordinator reminders

`POST /groups/:id/reminders` nudges members who still owe. Each member can be reminded at most once
every `REMINDER_COOLDOWN_HOURS` (default 24). Members still in cooldown come back in `skipped[]` with
`nextAllowedAt`. If everyone is in cooldown, the endpoint returns `REMINDER_COOLDOWN` (429).

---

## Deploying on Render

1. Push this repo and create a **Blueprint** from `render.yaml`. It creates the web service
   (health check `/health`), the cron job, and a shared env group. The build step installs dev
   dependencies to compile TypeScript, then prunes them (`npm ci --include=dev && npm run build && npm prune --omit=dev`).
2. Fill in the `sync: false` secrets: `MONGODB_URI` (MongoDB Atlas), `SQUADCO_SECRET_KEY`,
   `SQUADCO_MERCHANT_ID`, `ZEPTOMAIL_TOKEN`, `ZEPTOMAIL_FROM_ADDRESS`, `FIREBASE_SERVICE_ACCOUNT`
   (raw JSON or base64), `PUBLIC_BASE_URL`, and `CORS_ORIGINS` (include the Vercel site origin).
3. In the Squadco dashboard, set the webhook URL to `https://<your-api>/api/v1/webhooks/squadco`.
   Signatures are verified with HMAC-SHA512 of the raw body in `x-squad-encrypted-body`.
4. Indexes are created on boot.

Dev routes (`/api/v1/dev/*`) are off in production unless `ENABLE_DEV_ROUTES=true`.

## Project layout

```
src/
  app.ts, server.ts, db.ts      Express app, boot, Mongo connection
  config/env.ts                  all configuration (env-driven)
  models/                        Mongoose schemas (User, Group, Membership, Cycle, Contribution,
                                 PaymentAttempt, Payout, Transaction, + Announcement, ActivityLog,
                                 Notification, Reminder, SupportTicket, Otp, RefreshToken, RateLimit, …)
  services/                      business logic: cycles, payments, payouts, groups, otp, tokens,
                                 rateLimiter, notify, squadco, zeptomail, push, references
  routes/                        auth, users, groups, money, account, public, webhooks, admin, dev
  jobs/                          scheduled tasks + Render cron entry point
  seed/seed.ts                   fixture data
docs/API.md, docs/openapi.json, docs/ERRORS.md
test/                            end-to-end API tests (node:test + supertest)
```

### Typing conventions

* **Models:** schemas are declared once and Mongoose infers the TypeScript types from them, virtuals
  included. Each model file exports its document type (`UserDoc`, `GroupDoc`, `PaymentAttemptDoc`, …).
  Status fields are string-literal unions built from `as const` arrays (`PayoutStatus`,
  `ContributionStatus`, …), so an invalid status fails to compile.
* **Requests:** handlers call `parseBody(schema, req)` / `parseQuery(schema, req)`. These return the
  zod-inferred type, so every request body is typed and validated in one step. `currentUser(req)`
  returns the signed-in `UserDoc` on routes behind `auth`.
* **Responses:** `toJson(doc)` returns `Json<Doc>`, which is the document's schema fields with
  ObjectIds as strings and `_id` replaced by `id`.
* **Money:** amounts are `Kobo` (an alias for `number`) at every money-handling signature.
* **Gateway results** are discriminated unions (`PaymentOutcome`, `TransferOutcome`), so every
  handler has to deal with each outcome.

---

## Open questions for the client

1. **Squadco vs Paystack.** The Review Group and Group Activated mockups say *"Payments go through
   Paystack, not the group organiser."* The client's later comment names **Squadco**, so the backend
   is built on Squadco. Those two screens need their copy corrected. The API's own copy
   (`paymentNote` on review and activate) says "TurnByTurn's payment partner (Squadco)".
2. **Automatic vs manual payout release.** The Payout Eligible screen has a "Start payout" button, so
   release is **manual** (coordinator or staff) by default. Set `AUTO_START_PAYOUTS=true` to release
   automatically once a cycle is fully funded.
3. **Overdue grace period.** Defaults to 24h after the due date (`CYCLE_OVERDUE_GRACE_HOURS`), then
   7 days until Resolution Required (`CYCLE_RESOLUTION_AFTER_DAYS`). Both need confirming.
4. **Income fields.** `income.fixedIncome` and `income.variableIncome` are stored for information only.
   No eligibility logic uses them.

## Things to verify against live Squadco before launch

* The request and response field names for `/transaction/initiate`, `/transaction/verify/:ref`,
  `/payout/account/lookup`, `/payout/transfer`, `/payout/requery` and `/sms/send/instant` follow
  Squadco's public docs. Confirm them in the sandbox, especially the transfer status values and the
  shape of the transfer webhook (`src/services/squadco.ts` and `src/routes/webhooks.ts` hold all of
  this mapping).
* The bank list in `src/content/banks.json` uses NIP institution codes. Check it against Squadco's
  bank-code list.
* Money updates rely on atomic single-document operations and idempotency keys rather than multi-document
  transactions, so they work on any MongoDB deployment. If a process crashes between claiming a
  payment and crediting it, the attempt is left in `processing` and needs a manual check.
