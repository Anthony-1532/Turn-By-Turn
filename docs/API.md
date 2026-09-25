# TurnByTurn API Reference

Base URL: `https://<your-render-host>/api/v1` (locally `http://localhost:4000/api/v1`)

Machine-readable spec: `GET /api/v1/openapi.json` · Swagger UI: `GET /api/v1/docs` · Health: `GET /health`

The server is written in **TypeScript** (strict mode) on Express 4. Each section below says which
source file implements it, and the [TypeScript types](#typescript-types) section maps every
response object to the exported type that defines it. Backend engineers can work from those types;
the Flutter team can use the JSON examples.

---

## Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <accessToken>`. Every endpoint needs it unless marked **Public**. |
| Content type | `application/json` (photo upload is `multipart/form-data`) |
| Money | Always **integer kobo**. ₦50,000 = `5000000`. |
| Phones | Any Nigerian format in (`08031234567`, `+234 803 123 4567`); stored and returned as E.164 (`+2348031234567`). |
| IDs | 24-char hex MongoDB ObjectIds. A malformed ID returns `404 NOT_FOUND`. |
| Dates | ISO 8601 UTC. Business day boundaries use Africa/Lagos. |
| Pagination | Cursor-style: pass the previous response's `nextBefore` as `?before=`. `null` means no more pages. |
| Empty states | Successful responses with empty arrays, never errors. |

### Error shape

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

Branch on `code`. `retryAfter` (seconds) is also sent as the `Retry-After` header. Every endpoint can also return `VALIDATION_ERROR` (400, `details[] = {field, message}`), and authenticated endpoints can return `UNAUTHENTICATED` / `SESSION_EXPIRED` (401). The full code list with the screen each one maps to is in [`ERRORS.md`](ERRORS.md).

### Session handling

1. Access tokens live 15 minutes (`accessTokenExpiresIn` seconds).
2. On `401 SESSION_EXPIRED`, call `POST /auth/refresh` once with the stored refresh token.
3. Store the **new** refresh token it returns; the old one is now dead.
4. If refresh also returns `SESSION_EXPIRED`, send the user to Sign In.

---

## 1. Auth

Source: `src/routes/auth.ts` · services `otp.ts`, `tokens.ts`, `rateLimiter.ts`

| Method | Path | Auth | Screen |
|---|---|---|---|
| POST | `/auth/signup` | Public | Create Account (1/4) |
| POST | `/auth/resend-otp` | Public | Verify Contact: resend |
| POST | `/auth/verify-otp` | Public | Verify Contact (2/4) |
| POST | `/auth/password-strength` | Public | Create Password: live guidance |
| POST | `/auth/set-password` | Public | Create Password (3/4) |
| POST | `/auth/sign-in` | Public | Sign In |
| POST | `/auth/refresh` | Public | (silent) |
| POST | `/auth/sign-out` | Bearer | Sign Out |
| POST | `/auth/forgot-password` | Public | Forgot Password → Reset Code Sent |
| POST | `/auth/reset-password` | Public | Reset Password |

### `POST /auth/signup` → 201
Sends a 6-digit SMS code. Calling it again with a new phone is the "change number" flow (the unfinished sign-up is reused).

```json
// request
{ "name": "Ada Obi", "phone": "08031234567", "email": "ada@example.com" }
// response
{ "signupId": "66f1…", "phone": "+2348031234567", "expiresIn": 600, "resendAvailableIn": 60 }
```
Errors: `ACCOUNT_EXISTS` (409, `details.field` = `phone`|`email`), `OTP_RESEND_COOLDOWN` (429), `TOO_MANY_ATTEMPTS` (429).

### `POST /auth/resend-otp` → 200
```json
{ "phone": "08031234567", "purpose": "signup" }   // purpose: signup | reset_password
```
Returns `{ expiresIn, resendAvailableIn }`. Errors: `OTP_RESEND_COOLDOWN`, `TOO_MANY_ATTEMPTS`.

### `POST /auth/verify-otp` → 200
```json
// request
{ "phone": "08031234567", "code": "123456" }
// response
{ "verified": true, "setupToken": "eyJ…", "passwordRules": ["At least 8 characters", "At least one letter", "At least one number"] }
```
`setupToken` is valid 30 minutes. Errors: `OTP_INVALID` (400, `details.attemptsRemaining`), `OTP_EXPIRED` (400), `TOO_MANY_ATTEMPTS` after 5 wrong codes (request a new code to unlock).

### `POST /auth/password-strength` → 200
```json
{ "password": "hunter2" }
→ { "valid": false, "strength": "weak", "rules": [...], "errors": ["Use at least 8 characters", "Include at least one letter"] }
```

### `POST /auth/set-password` → 201
Activates the account and signs the user in.
```json
// request
{ "setupToken": "eyJ…", "password": "Password123", "confirmPassword": "Password123" }
// response
{
  "user": { "id": "…", "name": "Ada Obi", "phone": "+234…", "email": "…",
            "onboarding": { "phoneVerified": true, "passwordSet": true, "payoutAccountLinked": false, "trustedContactDone": false } },
  "accessToken": "eyJ…", "accessTokenExpiresIn": 900, "refreshToken": "…", "tokenType": "Bearer",
  "passwordStrength": "medium"
}
```
Errors: `PASSWORD_POLICY` (422, `details[]` per failed rule or mismatch), `SESSION_EXPIRED` (setup token expired), `ACCOUNT_EXISTS`, `SIGNUP_INCOMPLETE`.

### `POST /auth/sign-in` → 200
```json
{ "identifier": "08031234567 or ada@example.com", "password": "Password123" }
→ { "user": {…}, "accessToken": "…", "accessTokenExpiresIn": 900, "refreshToken": "…", "tokenType": "Bearer" }
```
Errors: `INVALID_CREDENTIALS` (401, `details.attemptsRemaining`), `TOO_MANY_ATTEMPTS` (429 with `retryAfter`; 5 failures in 15 min locks for 15 min, even with the right password), `ACCESS_DENIED` (suspended account).

### `POST /auth/refresh` → 200
`{ "refreshToken": "…" }` → `{ accessToken, accessTokenExpiresIn, refreshToken, tokenType }`. Reusing a rotated token revokes the whole session chain. Error: `SESSION_EXPIRED`.

### `POST /auth/sign-out` → 200
`{ "refreshToken": "…" }` or `{ "allDevices": true }` → `{ "signedOut": true }`.

### `POST /auth/forgot-password` → 200
`{ "identifier": "phone or email" }` → `{ "sent": true, "maskedPhone": "+234803****67", "expiresIn": 600, "resendAvailableIn": 60 }`. The response looks the same whether or not the account exists (`maskedPhone` is `null` when it doesn't).

### `POST /auth/reset-password` → 200
`{ "identifier": "…", "code": "123456", "password": "NewPass1", "confirmPassword": "NewPass1" }` → `{ "reset": true }`. Revokes every existing session. Errors: `OTP_INVALID`, `OTP_EXPIRED`, `PASSWORD_POLICY`, `TOO_MANY_ATTEMPTS`.

---

## 2. Profile & settings (`/users/me`)

Source: `src/routes/users.ts` · bank lookup in `services/squadco.ts` (`resolveAccount`)

| Method | Path | Screen |
|---|---|---|
| GET | `/users/me` | Profile |
| PATCH | `/users/me` | Personal Information |
| PUT | `/users/me/photo` | Profile photo upload |
| DELETE | `/users/me/photo` | Remove photo |
| POST | `/users/me/bank-account/resolve` | Account Verified (name lookup) |
| PUT | `/users/me/bank-account` | Payout Account (4/4) / Bank Account |
| GET | `/users/me/bank-account` | Bank Account |
| PUT | `/users/me/trusted-contact` | Trusted Contact |
| DELETE | `/users/me/trusted-contact` | Trusted Contact: remove |
| GET | `/users/me/notification-preferences` | Notifications (prefs) |
| PATCH | `/users/me/notification-preferences` | Notifications (prefs) |
| POST | `/users/me/password` | Password & Security |
| POST | `/users/me/devices` | Register FCM token |
| DELETE | `/users/me/devices` | Unregister FCM token |

### `GET /users/me` → 200
```json
{ "user": {
  "id": "…", "name": "Ngozi Okafor", "initials": "NO", "phone": "+2348031000001", "email": "…",
  "profilePhotoUrl": "/api/v1/files/66f1…",
  "income": { "fixedIncome": 30000000, "variableIncome": 5000000 },
  "bankAccount": { "bankCode": "000013", "bankName": "Guaranty Trust Bank", "accountNumber": "0123000001",
                   "accountName": "NGOZI OKAFOR", "verified": true, "nameMatch": true, "verifiedAt": "…" },
  "trustedContact": { "name": "…", "phone": "+234…", "relationship": "Sibling", "skipped": false },
  "notificationPreferences": { "push": true, "email": true, "sms": false, "paymentReminders": true,
                               "groupActivity": true, "announcements": true, "payoutUpdates": true },
  "onboarding": { "phoneVerified": true, "passwordSet": true, "payoutAccountLinked": true, "trustedContactDone": true },
  "groupCount": 2
} }
```

### `PATCH /users/me`
`{ "name": "…", "income": { "fixedIncome": 30000000, "variableIncome": null } }`. `null` clears a field. Phone and email are not editable here.

### `PUT /users/me/photo`
`multipart/form-data`, field `photo`: JPEG, PNG, WebP or HEIC, 5 MB max. Returns `{ user }` with the new `profilePhotoUrl` (served publicly from `GET /files/:id`).

### `POST /users/me/bank-account/resolve` → 200
```json
{ "bankCode": "000013", "accountNumber": "0123456789" }
→ { "bankCode": "000013", "bankName": "Guaranty Trust Bank", "accountNumber": "0123456789",
    "accountName": "ADA OBI", "nameMatch": true }
```
Nothing is saved. Show the name so the user can confirm or edit. Errors: `BANK_VERIFICATION_FAILED` (422), `GATEWAY_ERROR` (502).

### `PUT /users/me/bank-account` → 200
Same body. The server looks the name up again itself (a client-supplied name is never trusted) and saves it. Returns `{ bankAccount, user }`.

### `PUT /users/me/trusted-contact`
`{ "name": "…", "phone": "…", "relationship": "Sister" }` or `{ "skipped": true }` → `{ trustedContact }`.

### `PATCH /users/me/notification-preferences`
Any subset of `push, email, sms, paymentReminders, groupActivity, announcements, payoutUpdates` (booleans) → `{ preferences }`.

### `POST /users/me/password`
`{ "currentPassword": "…", "newPassword": "…" }` → `{ changed: true, accessToken, refreshToken, … }`. Other devices are signed out. Errors: `INVALID_CREDENTIALS`, `PASSWORD_POLICY`.

### `POST /users/me/devices` → 201
`{ "token": "<FCM token>", "platform": "android" | "ios" | "web" }`. Call after sign-in and whenever FCM rotates the token. `DELETE` with `{ token }` on sign-out.

---

## 3. Home, history & notifications

Source: `src/routes/account.ts`

| Method | Path | Screen |
|---|---|---|
| GET | `/home` | Member Home / Returning Home |
| GET | `/transactions` | History (payment list) |
| GET | `/transactions/filters` | History → Filter sheet |
| GET | `/transactions/:id` | Transaction details |
| GET | `/notifications` | Notifications |
| POST | `/notifications/read` | Mark read |

### `GET /home` → 200
```json
{
  "user": { "id": "…", "name": "Ngozi Okafor", "initials": "NO", "profilePhotoUrl": null },
  "summary": { "groupCount": 2, "coordinatingCount": 1, "totalOutstanding": 2000000 },
  "nextDue": { "groupId": "…", "name": "Family Circle", "role": "member", "currentCycle": {…},
               "myContribution": { "id": "…", "amountDue": 2000000, "amountPaid": 0, "outstanding": 2000000, "status": "unpaid" } },
  "upcomingPayout": { /* Payout object, see §7 */ },
  "groups": [ { "groupId": "…", "name": "Unity Women's Ajo", "status": "active", "role": "coordinator",
                "payoutPosition": 1, "hasReceivedPayout": true, "contributionAmount": 5000000,
                "currentCycle": {…}, "myContribution": {…}, "nextRecipient": {…} } ],
  "unreadNotifications": 3,
  "quickActions": ["pay", "join-group", "create-group", "history"]
}
```
Groups are sorted by soonest due date.

### `GET /transactions`
Query (all optional): `month=2026-09`, `from`, `to` (ISO dates), `status` (`pending|success|failed|under_review|reversed`), `type` (`contribution|fee|payout|refund|adjustment`), `groupId`, `before`, `limit` (1–200, default 50).

```json
{
  "months": [
    { "month": "2026-09", "label": "September 2026", "totalOut": 5100000, "totalIn": 50000000,
      "transactions": [
        { "id": "…", "type": "contribution", "direction": "debit", "amount": 5000000, "status": "success",
          "reference": "TRX-0926-0042", "groupId": "…", "groupName": "Unity Women's Ajo", "cycleId": "…",
          "description": "September cycle contribution", "createdAt": "…",
          "meta": { "kind": "full", "requested": 5000000, "credited": 5000000, "excess": 0, "gatewayAmountReceived": 5100000 } },
        { "id": "…", "type": "fee", "direction": "debit", "amount": 100000, "status": "success",
          "reference": "TRX-0926-0042", "description": "TurnByTurn service fee (2%)", … }
      ] }
  ],
  "count": 2,
  "nextBefore": null
}
```
`direction` is from the user's point of view: `debit` means money out (contributions, fees), `credit` means money in (payouts, refunds). A payment writes two rows (contribution and fee) that share one `reference`.

### `GET /transactions/filters`
`{ periods: [{month, label}], statuses: [...], types: [...], groups: [{id, name}] }`: only values the user actually has.

### `GET /transactions/:id`
`{ transaction, related: [rows sharing the reference], receipt: Receipt|null, payout: Payout|null }`.

### `GET /notifications`
Query: `before`, `limit` (≤100, default 30), `unreadOnly=true`. → `{ notifications: [{id, type, title, body, groupId, data, read, createdAt}], unreadCount, nextBefore }`.

Notification `type` values: `cycle_opened`, `payment_received`, `partial_payment_received`, `payment_reminder`, `cycle_overdue`, `cycle_resolution_required`, `payout_eligible`, `payout_sent`, `payout_failed`, `payout_delayed_recovery`, `announcement`, `member_joined`, `group_invite`, `group_activated`, `reconciliation_update`. Push payloads carry the same `type`, `groupId` and `data` fields for deep-linking.

### `POST /notifications/read`
`{ "ids": ["…"] }` or `{ "all": true }` → `{ updated: n }`.

---

## 4. Groups: create (coordinator wizard)

Source: `src/routes/groups.ts` · helpers in `services/groups.ts` (`setupStatus`, `groupSummary`, `memberDisplay`)

| Step | Method | Path |
|---|---|---|
| Basics (1/5) | POST | `/groups` |
| Basics / Cycle (2/5) | PATCH | `/groups/:id/draft` |
| Wizard state | GET | `/groups/:id/setup` |
| Members (3/5) | POST | `/groups/:id/members` |
| Remove member | DELETE | `/groups/:id/members/:membershipId` |
| Payout Order (4/5) | PUT | `/groups/:id/payout-order` |
| Review (5/5) | GET | `/groups/:id/review` |
| Activated | POST | `/groups/:id/activate` |

All wizard endpoints except activate return the same **DraftView**:
```json
{
  "group": { "id": "…", "name": "Unity Women's Ajo", "status": "draft", "contributionAmount": 5000000,
             "memberCount": 10, "cycleFrequency": "monthly", "firstDueDate": "…",
             "expectedCycleTotal": 50000000, "platformFeePercent": 2, "feeNote": "TurnByTurn fee: 2% added on top",
             "perMemberCharge": { "contribution": 5000000, "serviceFee": 100000, "total": 5100000, "feePercent": 2 },
             "payoutOrder": ["<membershipId>", …], "inviteCode": "FM65M6", "inviteLink": "https://turnbyturn.app/join/FM65M6",
             "coordinatorParticipates": true, "isLocked": false, "rules": [] },
  "setup": { "steps": { "basics": true, "cycle": true, "members": false, "payoutOrder": false },
             "participantsAdded": 4, "missing": ["members", "payoutOrder"], "readyToActivate": false },
  "members": [ /* Member objects, see below */ ]
}
```

**Member object** (used everywhere):
```json
{ "membershipId": "…", "userId": "…|null", "name": "Amaka Eze", "initials": "AE", "profilePhotoUrl": null,
  "phone": "+234…", "role": "member", "status": "joined", "participant": true,
  "payoutPosition": 2, "hasReceivedPayout": false, "joinedAt": "…" }
```
Member `status`: `pending` (phone has no TurnByTurn account yet, so they got an SMS), `invited` (existing user, not accepted yet), `joined`, `removed`.

### `POST /groups` → 201
`{ "name": "…", "contributionAmount": 5000000, "description": "…", "coordinatorParticipates": true }`. The caller becomes coordinator. If `coordinatorParticipates` is true they also contribute and take a turn.

### `PATCH /groups/:id/draft`
Any subset of: `name`, `description`, `contributionAmount` (min ₦100), `cycleFrequency` (`weekly|biweekly|monthly`), `firstDueDate` (today or later), `memberCount` (2–100, not below the current number of members), `coordinatorParticipates`, `rules` (string[] ≤20). Errors: `GROUP_NOT_DRAFT`, `ACCESS_DENIED`, `VALIDATION_ERROR`.

### `POST /groups/:id/members` → 201
`{ "phone": "08031234567", "name": "Optional display name" }`. Existing users get an in-app invite; others get an SMS with the code. Returns `{ membership, ...DraftView }`. Errors: `GROUP_FULL` (raise `memberCount` first), `CONFLICT` (already in group), `GROUP_NOT_DRAFT`.

### `PUT /groups/:id/payout-order`
`{ "order": ["<membershipId>", …] }`: must list every participating member exactly once. Index 0 is paid first.

### `GET /groups/:id/review`
DraftView + `{ summary: { name, contributionAmount, cycleFrequency, firstDueDate, memberCount, expectedCycleTotal, platformFeePercent, perMemberCharge, payoutOrder: [Member] }, warning: "Amount and turn order cannot change after the group starts.", paymentNote }`.

### `POST /groups/:id/activate` → 200
Locks amount and order and opens cycle 1.
```json
{ "group": {… "status": "active" }, "currentCycle": { /* Cycle */ },
  "invite": { "code": "FM65M6", "link": "https://turnbyturn.app/join/FM65M6" }, "paymentNote": "…" }
```
Errors: `GROUP_SETUP_INCOMPLETE` (422, `details.missing[]`: e.g. `["members","payoutOrder","firstDueDate"]`), `GROUP_NOT_DRAFT`. Activation is allowed while some members are still `invited`/`pending`; they keep their reserved slot.

---

## 5. Groups: join & view

Source: `src/routes/groups.ts` · `services/groups.ts` (`paymentRoster`, `cycleView`, `nextRecipient`)

| Method | Path | Who | Screen |
|---|---|---|---|
| GET | `/groups` | any | Groups tab (empty array = No groups) |
| POST | `/groups/join/preview` | any | Join Group step 2 |
| POST | `/groups/join` | any | Join Successful |
| GET | `/groups/:id` | member | Group Overview |
| GET | `/groups/:id/info` | member | Group Information |
| GET | `/groups/:id/members` | member | Group Members |
| GET | `/groups/:id/payout-order` | member | Payout Order / Turn Order (Locked) |
| GET | `/groups/:id/cycles` | member | cycle list |
| GET | `/groups/:id/cycles/current` | member | Cycle Progress / Cycle Overdue |
| GET | `/groups/:id/payment-status` | member | Payment Status / Who Has Paid |
| GET | `/groups/:id/payouts` | member | payout list |
| GET | `/groups/:id/announcements` | member | Announcements |
| GET | `/groups/:id/activity` | member | Group Activity / Activity |
| GET | `/groups/:id/invite` | member | Invite Members (share) |

Non-members get `403 ACCESS_DENIED`; an unknown group ID gets `404 NOT_FOUND`.

### `GET /groups`
`{ groups: [ Group + { viewerRole, myPayoutPosition, currentCycle, myContribution } ] }`.

### `POST /groups/join/preview`
`{ "code": "FM65M6" }`. Also accepts `TBT-FM65M6`, lowercase, or a full link `https://turnbyturn.app/join/FM65M6`.
```json
{ "group": { "id": "…", "name": "…", "description": "…", "status": "draft", "contributionAmount": 5000000,
             "cycleFrequency": "monthly", "memberCount": 10, "expectedCycleTotal": 50000000,
             "firstDueDate": "…", "coordinatorName": "Ngozi Okafor", "joinedCount": 7 },
  "perMemberCharge": { "contribution": 5000000, "serviceFee": 100000, "total": 5100000, "feePercent": 2 },
  "offeredPosition": 8,
  "positionIsFinal": false }
```
Errors: `INVITE_INVALID` (404), `ALREADY_MEMBER` (409, `details.groupId`), `GROUP_FULL` (409: full, or already active and you weren't invited).

### `POST /groups/join` → 201
Same body → `{ group, membership, payoutPosition, firstDueDate }`. If the coordinator added your phone, you claim that reserved slot.

### `GET /groups/:id`
```json
{ "group": {…}, "viewerRole": "coordinator", "viewerLabel": "You manage this group",   // or "member" / "Member-only group"
  "myMembership": {…}, "myContribution": { /* Contribution */ },
  "currentCycle": { /* Cycle */ },
  "progress": { "expected": 50000000, "confirmed": 37000000, "outstanding": 13000000, "percentReceived": 74, "paidCount": 6, "totalMembers": 10 },
  "nextRecipient": { /* Member + cycleNumber, dueDate, payoutStatus */ },
  "membersPreview": [ /* first 5 Members */ ], "memberTotal": 10,
  "setup": { /* only while draft */ } }
```

**Cycle object:**
```json
{ "id": "…", "groupId": "…", "cycleNumber": 2, "periodLabel": "September cycle", "dueDate": "…", "daysUntilDue": 3,
  "expectedTotal": 50000000, "confirmedReceived": 37000000, "outstandingAmount": 13000000, "percentReceived": 74,
  "status": "open", "recipientMembershipId": "…", "recipientUserId": "…" }
```
Cycle `status`: `open` → `complete`, or `open` → `overdue` → `resolution_required`. Monthly cycles are labelled by month ("September cycle"); weekly and biweekly ones are "Cycle N".

### `GET /groups/:id/info`
`{ group, coordinator: {id, name, phone}, rules: [...], policies: [...] }`.

### `GET /groups/:id/payout-order`
```json
{ "locked": true, "policy": "Amount and turn order cannot change after the group starts.",
  "order": [ { "position": 1, …Member, "isMe": false, "payoutStatus": "sent",
               "cycle": { "number": 1, "dueDate": "…", "periodLabel": "August cycle" } },
             { "position": 3, …, "payoutStatus": "upcoming", "cycle": null } ] }
```

### `GET /groups/:id/payment-status` (optional `?cycleId=`, defaults to the current cycle)
```json
{ "cycle": {…}, "paidCount": 6, "unpaidCount": 4,
  "members": [ { …Member, "memberStatus": "joined", "contributionId": "…", "amountDue": 5000000, "amountPaid": 2000000,
                 "outstanding": 3000000, "status": "partial", "paidAt": "…", "confirmedAt": null, "isRecipient": false } ] }
```
In a roster row, `status` is the **contribution** status (`unpaid`, `partial`, `paid`, `reconciliation_required`, `under_review`). The member's own status (`joined`, `invited`, …) is in `memberStatus`.

### `GET /groups/:id/cycles/current`
Payment-status payload + `outstandingMembers[]` + `payout` (Payout object). Drives both Cycle Progress and Cycle Overdue. When nothing is active it returns `{ cycle: null }`.

### `GET /groups/:id/activity`
Query `before`, `limit` (≤100). → `{ activity: [{ id, eventType, summary, actorId, actorName, createdAt, data }], nextBefore }`. `actorName` is `"TurnByTurn"` for system events. Event types: `group_activated`, `member_invited`, `member_joined`, `cycle_opened`, `payment_full`, `payment_partial`, `cycle_complete`, `cycle_overdue`, `cycle_resolution_required`, `payout_started`, `payout_sent`, `payout_failed`, `announcement`, `reminder_sent`, `settings_updated`, `reconciliation_submitted`, `cycle_extended`, `cycle_released`, `group_completed`.

### `GET /groups/:id/invite`
`{ code, link, canShare, shareMessage }`.

---

## 6. Coordinator-only

Source: `src/routes/groups.ts` (dashboard, member detail, settings, announcements, reminders) · `src/routes/money.ts` (start payout)

All of these return `403 ACCESS_DENIED` for plain members.

| Method | Path | Screen |
|---|---|---|
| GET | `/groups/:id/dashboard` | Manage Group |
| GET | `/groups/:id/members/:membershipId` | Member Detail (members can view their own) |
| PATCH | `/groups/:id/settings` | Group Settings |
| POST | `/groups/:id/announcements` | Post announcement |
| GET | `/groups/:id/reminders` | Reminders history |
| POST | `/groups/:id/reminders` | Reminders → Reminder Sent |
| POST | `/payouts/:id/start` | Payout Eligible → Start payout |

### `GET /groups/:id/dashboard`
```json
{ "group": {…}, "currentCycle": {…}, "collected": 37000000, "expected": 50000000, "remaining": 13000000,
  "paidCount": 6, "unpaidCount": 4, "outstandingMembers": [ /* roster rows */ ],
  "nextRecipient": {…}, "payout": { /* Payout */ }, "recentActivity": [ /* last 5 */ ],
  "quickLinks": ["payment-status", "add-member", "remind", "turn-order", "activity", "announcements"] }
```

### `GET /groups/:id/members/:membershipId`
```json
{ "member": {…},
  "currentState": { "cycleNumber": 2, "periodLabel": "September cycle", "required": 5000000, "received": 2000000, "due": 3000000, "status": "partial" },
  "totals": { "required": 10000000, "received": 7000000, "due": 3000000 },
  "history": [ { "cycleId": "…", "cycleNumber": 1, "periodLabel": "August cycle", "dueDate": "…", "required": 5000000, "received": 5000000, "due": 0, "status": "paid" }, … ],
  "payments": [ { "reference": "TRX-0826-0007", "amount": 5000000, "kind": "full", "paidAt": "…", "cycleId": "…" } ] }
```

### `PATCH /groups/:id/settings`
`{ name?, description?, rules? }`. Money fields and turn order can't be edited here.

### `POST /groups/:id/announcements` → 201
`{ "title": "…", "body": "…" }` → `{ announcement }`. Pushes to every member.

### `POST /groups/:id/reminders` → 201
```json
// request (all optional; default = everyone who still owes, push only)
{ "membershipIds": ["…"], "message": "Please pay before Friday", "channels": ["push", "sms", "email"] }
// response
{ "reminder": {…}, "sentCount": 3,
  "skipped": [ { "membershipId": "…", "reason": "cooldown", "nextAllowedAt": "…" } ] }
```
Each member can be reminded at most once per 24h. Errors: `REMINDER_COOLDOWN` (429, `details.skipped`) when nobody could be reminded, `GROUP_NOT_ACTIVE`.

---

## 7. Paying a contribution

Source: `src/routes/money.ts` · money logic in `services/payments.ts` (`quote`, `initiateContributionPayment`, `applyPaymentOutcome`, `receiptFor`)

Flow: **my-contribution → quote → pay → open checkoutUrl → verify → receipt**

| Method | Path | Screen |
|---|---|---|
| GET | `/cycles/:id` | Cycle detail (roster + payout) |
| GET | `/cycles/:id/my-contribution` | Start / Unpaid / Part paid |
| GET | `/cycles/:id/contributions/quote?amount=` | Pay part → Review |
| POST | `/cycles/:id/contributions` | Pay → Squadco checkout |
| GET | `/cycles/:id/contributions` | Roster |
| POST | `/payments/:reference/verify` | after checkout closes |
| GET | `/payments/:reference` | payment status |
| GET | `/payments/:reference/receipt` | Payment receipt |
| GET | `/receipts` | Payment Receipts |
| GET | `/contributions/:id` | contribution |
| POST | `/contributions/:id/reconcile` | Reconciliation Required → Review Submitted |
| POST | `/cycles/:id/support` | Resolution Required → Contact support |

### `GET /cycles/:id/my-contribution`
```json
{ "cycle": {…},
  "contribution": { "id": "…", "amountDue": 5000000, "amountPaid": 2000000, "outstandingAmount": 3000000,
                    "serviceFeePaid": 40000, "excessAmount": 0, "status": "partial", "lastPaymentReference": "TRX-0925-0003" },
  "payments": [ { "reference": "TRX-0925-0003", "kind": "partial", "amount": 2000000, "serviceFee": 40000, "total": 2040000, "paidAt": "…" } ],
  "acceptingPayments": true }
```
Payments are still accepted while a cycle is `overdue` or `resolution_required`.

### `GET /cycles/:id/contributions/quote?amount=2000000`
Leave out `amount` to quote the full outstanding balance.
```json
{ "quote": { "kind": "partial", "contribution": 2000000, "serviceFee": 40000, "total": 2040000, "feePercent": 2,
             "amountDue": 5000000, "alreadyPaid": 0, "outstandingBefore": 5000000, "remainingAfter": 3000000 } }
```
Errors: `AMOUNT_INVALID` (422: more than outstanding, or a part payment below ₦100; `details.outstanding` / `details.minimum`), `NOTHING_DUE`.

### `POST /cycles/:id/contributions` → 201
`{ "amount": 2000000 }` (omit to pay in full)
```json
{ "reference": "TRX-0925-0003",
  "checkoutUrl": "https://…squadco…/checkout/…",
  "quote": { … },
  "payment": { "id": "…", "reference": "TRX-0925-0003", "kind": "partial", "amount": 2000000, "serviceFee": 40000,
               "totalCharged": 2040000, "status": "pending", … } }
```
Open `checkoutUrl` in a WebView. The member is charged `total`. Errors: `AMOUNT_INVALID`, `NOTHING_DUE`, `CYCLE_CLOSED`, `GATEWAY_ERROR`.

### `POST /payments/:reference/verify` → 200
Call this when the checkout closes. It is idempotent with the webhook, so calling it twice is safe.
```json
{ "payment": { …, "status": "success", "amountCredited": 2000000, "gatewayAmountReceived": 2040000 },
  "contribution": { …, "outstandingAmount": 3000000 },
  "result": "partial_payment_received" }
```
`result` picks the screen: `full_payment_received` · `partial_payment_received` · `reconciliation_required` · `pending` (bank still confirming, so poll) · `failed` · `abandoned`.

### `GET /payments/:reference/receipt`
```json
{ "receipt": {
  "reference": "TRX-0925-0003", "status": "success", "kind": "partial", "paidAt": "…",
  "payer": { "id": "…", "name": "Zainab Musa", "phone": "+234…" },
  "group": { "id": "…", "name": "Unity Women's Ajo" },
  "cycle": { "id": "…", "number": 2, "periodLabel": "September cycle", "dueDate": "…" },
  "contribution": 2000000, "serviceFee": 40000, "total": 2040000,
  "amountReceived": 2040000, "amountCredited": 2000000, "excessAmount": 0, "channel": "Card",
  "cycleBalance": { "amountDue": 5000000, "amountPaid": 2000000, "outstanding": 3000000 },
  "currency": "NGN", "paymentProvider": "Squadco" } }
```
Visible to the payer, the group coordinator and staff. `GET /receipts?groupId=&limit=` lists the user's receipts.

### `POST /contributions/:id/reconcile` → 201
For contributions with `status: "reconciliation_required"` (the gateway confirmed more than was owed). `{ "note": "optional" }` → `{ contribution (status under_review), ticket, status: "review_submitted" }`. Calling it again returns the existing ticket. Staff resolve it; see §9.

### `POST /cycles/:id/support` → 201
`{ "message": "…" }` → `{ ticket }`. The only action available on a Resolution Required cycle: the MVP has no automatic refund, cancellation or voting.

---

## 8. Payouts

Source: `src/routes/money.ts` · state machine in `services/payouts.ts` (`startPayout`, `retryPayout`, `applyTransferOutcome`, `describePayout`)

| Method | Path | Who |
|---|---|---|
| GET | `/payouts` | my payouts across groups |
| GET | `/payouts/:id` | member of the group |
| POST | `/payouts/:id/start` | coordinator |
| POST | `/payouts/:id/support` | member of the group |

**Payout object** (drives Blocked / Eligible / Processing / Sent / Failed / Delayed Recovery):
```json
{ "id": "…", "status": "blocked",
  "group": { "id": "…", "name": "…" },
  "cycle": { "id": "…", "number": 2, "periodLabel": "September cycle", "dueDate": "…", "status": "open" },
  "recipient": { "id": "…", "name": "Amaka Eze", "initials": "AE" },
  "expectedAmount": 50000000, "confirmedAmount": 37000000, "outstandingAmount": 13000000,
  "blockingMembers": [ { "membershipId": "…", "name": "Zainab Musa", "outstanding": 3000000 } ],
  "reference": "PAY-0925-0001",
  "destination": { "bankCode": "000014", "bankName": "Access Bank", "accountNumber": "0123000002", "accountName": "AMAKA EZE" },
  "attempts": [ { "reference": "PAY-0925-0001", "status": "failed", "startedAt": "…", "finishedAt": "…", "failureReason": "…" } ],
  "sentAt": null, "failureReason": null }
```

State machine: `blocked` → (cycle fully paid) `eligible` → (Start payout) `processing` → `sent` | `failed` → (staff retry) `delayed_recovery` → `sent`.

The payout amount is the full pot (`contributionAmount × memberCount`). The 2% fee is never taken from it.

### `POST /payouts/:id/start` → 200
No body. → `{ payout }` (usually already `sent` or `failed`; `processing` if Squadco hasn't confirmed yet, in which case a job re-checks it). Errors: `PAYOUT_NOT_ELIGIBLE` (409, `details.status`), `PAYOUT_ACCOUNT_MISSING` (recipient has no verified bank), `ACCESS_DENIED`.

### `POST /payouts/:id/support` → 201
`{ "message": "…" }` → `{ ticket }`.

---

## 9. Support, reference data & admin

Source: `src/routes/account.ts` (support) · `src/routes/public.ts` (reference data) · `src/routes/admin.ts` (staff)

### Support (Bearer)
| Method | Path | Body |
|---|---|---|
| POST | `/support/tickets` | `{ kind: general\|payout\|cycle_resolution, message, groupId?, paymentReference? }` → 201 `{ ticket }` |
| GET | `/support/tickets` | → `{ tickets }` (mine) |

### Reference data (Public)
| Method | Path | Returns |
|---|---|---|
| GET | `/banks` | `{ banks: [{ code, name }] }`: Squadco bank codes for the bank picker (cached 24h) |
| GET | `/content/help` | `{ paymentHelp: [{q, a}], support: {email, phone, hours} }`: Payment Help screen |
| GET | `/invites/:code` | `{ code, group: {name, contributionAmount, cycleFrequency, memberCount, status}, appLinks }`: for the marketing site / deep link |
| GET | `/files/:id` | Profile photo bytes |

### Admin / staff (Bearer + `isAdmin`)
Manual, human-in-the-loop resolution. Non-staff get `403 ACCESS_DENIED`.

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/admin/tickets?status=open&kind=` | – | Support queue |
| POST | `/admin/tickets/:id/resolve` | `{ note }` | Close a ticket |
| POST | `/admin/contributions/:id/reconciliation` | `{ action: refunded\|credited\|dismissed, note?, gatewayReference? }` | Resolve an overpayment. Adds a `refund`/`adjustment` ledger row; the original row is kept |
| POST | `/admin/cycles/:id/resolve` | `{ action: extend_deadline\|release\|note, note, newDueDate? }` | Unstick an overdue cycle: `extend_deadline` reopens it; `release` marks it complete with what was collected so the payout can go |
| POST | `/admin/payouts/:id/start` | – | Start an eligible payout |
| POST | `/admin/payouts/:id/retry` | – | Failed → Delayed Recovery → retry transfer |
| POST | `/admin/users/:id/suspend` | `{ suspended: bool }` | Suspend / unsuspend |

---

## 10. Webhooks & internal

Source: `src/routes/webhooks.ts` · `src/app.ts` (internal jobs route) · jobs in `src/jobs/tasks.ts`

### `POST /webhooks/squadco` (Public, signed)
Set this as the webhook URL in the Squadco dashboard. The raw body is verified with HMAC-SHA512 (header `x-squad-encrypted-body`); a bad signature gets `401`. Handles `charge_successful` / failed charges (keyed by `TransactionRef` = our `TRX-…` reference) and transfer events (`PAY-…`). Each event is processed once: duplicates return `{ received: true, duplicate: true }`, and a crash returns 500 so Squadco retries.

### `POST /internal/jobs/run` (header `x-cron-secret: $CRON_SECRET`)
Runs the scheduled jobs immediately and returns a `JobReport` (`{ overdueCycles: 0, … }` with an `{ error }` entry for any job that failed). Normally the Render cron job runs `npm run jobs` (`node dist/jobs/run.js`) every 10 minutes instead.

---

## 11. Dev-only (`ENABLE_DEV_ROUTES`, off in production)

Source: `src/routes/dev.ts`

With Squadco in mock mode:

| Method | Path | Purpose |
|---|---|---|
| GET | `/dev/checkout/:reference` | Mock checkout page (what `checkoutUrl` points to) |
| POST | `/dev/payments/:reference/complete` | Simulate success; `?fail=1` to fail; body `{ "amount": <kobo> }` to simulate the gateway confirming a different total (e.g. an overpayment) |
| POST | `/dev/jobs/run` | Run the scheduled jobs now |

Mock test values: OTP `123456` when `OTP_DEV_FIXED_CODE=123456`; bank accounts ending `000` fail verification; accounts ending `999` fail payout transfers.

---

## TypeScript types

Every object in this reference has an exported TypeScript type. Import them from the source
instead of redefining shapes. The types match what the JSON actually contains (for example,
ObjectIds are typed as `string`).

### Response objects

| Object in this doc | Type | Defined in |
|---|---|---|
| Error body `{ error: { code, … } }` | `ErrorCode` (all codes), `ApiError` | `src/utils/errors.ts` |
| Session (`accessToken`, `refreshToken`, …) | `Session` | `src/services/tokens.ts` |
| Fee breakdown (`contribution`, `serviceFee`, `total`, `feePercent`) | `FeeBreakdown` | `src/utils/money.ts` |
| Group | `GroupSummary` (= `Json<GroupDoc>` + `inviteLink`, `feeNote`, `perMemberCharge`) | `src/services/groups.ts` |
| Wizard state `setup` | `SetupStatus` | `src/services/groups.ts` |
| Member object | `MemberView` | `src/services/groups.ts` |
| Cycle object | `CycleView` (= `Json<CycleDoc>` + `daysUntilDue`) | `src/services/groups.ts` |
| Payment-status row | `RosterRow`. Its `status` is the contribution status; the membership status is `memberStatus` | `src/services/groups.ts` |
| Payment-status payload | `PaymentRoster` | `src/services/groups.ts` |
| `nextRecipient` | `NextRecipient` | `src/services/groups.ts` |
| Quote | `Quote` | `src/services/payments.ts` |
| Receipt | `Receipt` | `src/services/payments.ts` |
| Verify `result` | `PaymentResult` | `src/routes/money.ts` |
| Payout object | `PayoutView` | `src/services/payouts.ts` |
| Transaction row | `Json<TransactionDoc>` | `src/models/Transaction.ts` |
| Job report | `JobReport` | `src/jobs/tasks.ts` |

`Json<D>` (in `src/models/plugins.ts`) is the serialised form of a document: its schema fields with
ObjectIds as strings and `_id` replaced by `id`. Computed (virtual) fields such as
`outstandingAmount` and `percentReceived` **are** in the JSON responses but are **not** part of the
`Json<D>` type, so read them from the documented examples.

### Enumerations

Each enum is exported both as a runtime array and as a string-literal type, so invalid values fail to compile.

| Values | Array → type | Defined in |
|---|---|---|
| Group status: `draft`, `active`, `completed` | `GROUP_STATUSES` → `GroupStatus` | `src/models/Group.ts` |
| Member role: `member`, `coordinator` | `MEMBERSHIP_ROLES` → `MembershipRole` | `src/models/Membership.ts` |
| Member status: `pending`, `invited`, `joined`, `removed` | `MEMBERSHIP_STATUSES` → `MembershipStatus` | `src/models/Membership.ts` |
| Cycle status: `open`, `complete`, `overdue`, `resolution_required` | `CYCLE_STATUSES` → `CycleStatus` | `src/models/Cycle.ts` |
| Frequency: `weekly`, `biweekly`, `monthly` | `FREQUENCIES` → `Frequency` | `src/utils/dates.ts` |
| Contribution status: `unpaid`, `partial`, `paid`, `reconciliation_required`, `under_review` | `CONTRIBUTION_STATUSES` → `ContributionStatus` | `src/models/Contribution.ts` |
| Payment kind / status | `PAYMENT_KINDS` → `PaymentKind`, `PAYMENT_STATUSES` → `PaymentStatus` | `src/models/PaymentAttempt.ts` |
| Payout status: `blocked` … `delayed_recovery` | `PAYOUT_STATUSES` → `PayoutStatus` | `src/models/Payout.ts` |
| Transaction type / status | `TRANSACTION_TYPES` → `TransactionType`, `TRANSACTION_STATUSES` → `TransactionStatus` | `src/models/Transaction.ts` |
| Notification `type` | `NotificationType` | `src/services/notify.ts` |
| Gateway outcomes | `PaymentOutcome`, `TransferOutcome` (discriminated unions) | `src/services/squadco.ts` |

Money fields are typed `Kobo`, which is an alias for `number` (`src/utils/money.ts`). The alias
documents the unit, but the compiler does **not** stop you passing naira where kobo is expected.

### Adding or changing an endpoint

1. Write the handler in the right `src/routes/*.ts` file. Read input with
   `parseBody(schema, req)` / `parseQuery(schema, req)` and the signed-in user with
   `currentUser(req)` (all from `src/middleware`). Throw `err('SOME_CODE')` for failures; add any
   new code to `ErrorCodes` in `src/utils/errors.ts` and to `docs/ERRORS.md`.
2. Put business logic in `src/services/`, not in the route.
3. Add the endpoint to `scripts/build-openapi.ts`, run `npm run docs`, and update this file. The
   spec is maintained by hand, not generated from the types, so all three must be updated together.
4. Add or extend a test in `test/`, then run `npm run typecheck` and `npm test`.

---

## Appendix: end-to-end happy path (curl)

```bash
# Server running locally: `npm run dev` (from source) or `npm run build && npm start` (compiled)
API=http://localhost:4000/api/v1
curl -X POST $API/auth/signup -H 'content-type: application/json' \
  -d '{"name":"Ada Obi","phone":"08031234567","email":"ada@example.com"}'
curl -X POST $API/auth/verify-otp -H 'content-type: application/json' -d '{"phone":"08031234567","code":"123456"}'
#   → setupToken
curl -X POST $API/auth/set-password -H 'content-type: application/json' -d '{"setupToken":"…","password":"Password123"}'
#   → accessToken (TOKEN below)
curl -X PUT $API/users/me/bank-account -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"bankCode":"000013","accountNumber":"0123456789"}'
curl -X POST $API/groups/join/preview -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"code":"FM65M6"}'
curl -X POST $API/groups/join -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"code":"FM65M6"}'
curl $API/home -H "authorization: Bearer $TOKEN"
#   → groups[0].currentCycle.id (CYCLE below)
curl -X POST $API/cycles/$CYCLE/contributions -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
#   → reference, checkoutUrl
curl -X POST $API/dev/payments/TRX-0925-0001/complete          # mock only: stands in for paying at checkoutUrl
curl -X POST $API/payments/TRX-0925-0001/verify -H "authorization: Bearer $TOKEN"
#   → result: full_payment_received
```
