'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, setup, teardown, signUp, auth } = require('./helpers');

before(setup);
after(teardown);

test('sign-up happy path returns a session and onboarding state', async () => {
  const u = await signUp({ name: 'Ada Obi' });
  const me = await api().get('/api/v1/users/me').set(auth(u.token));
  assert.equal(me.status, 200);
  assert.equal(me.body.user.name, 'Ada Obi');
  assert.equal(me.body.user.onboarding.payoutAccountLinked, true);
  assert.equal(me.body.user.bankAccount.nameMatch, true);
  assert.equal(me.body.user.passwordHash, undefined);
});

test('duplicate account → ACCOUNT_EXISTS', async () => {
  const u = await signUp();
  const r = await api().post('/api/v1/auth/signup').send({ name: 'Other', phone: u.phone, email: 'fresh@example.com' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ACCOUNT_EXISTS');
  assert.equal(r.body.error.details.field, 'phone');
});

test('wrong OTP → OTP_INVALID, then lockout → TOO_MANY_ATTEMPTS', async () => {
  const phone = '08091112222';
  await api().post('/api/v1/auth/signup').send({ name: 'Otp Person', phone, email: 'otp@example.com' }).expect(201);
  const r = await api().post('/api/v1/auth/verify-otp').send({ phone, code: '000000' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'OTP_INVALID');
  let last;
  for (let i = 0; i < 5; i += 1) last = await api().post('/api/v1/auth/verify-otp').send({ phone, code: '000000' });
  assert.equal(last.body.error.code, 'TOO_MANY_ATTEMPTS');
  // Even the right code is refused until a new one is requested.
  const ok = await api().post('/api/v1/auth/verify-otp').send({ phone, code: '123456' });
  assert.equal(ok.body.error.code, 'TOO_MANY_ATTEMPTS');
  await api().post('/api/v1/auth/resend-otp').send({ phone }).expect(200);
  await api().post('/api/v1/auth/verify-otp').send({ phone, code: '123456' }).expect(200);
});

test('weak password → PASSWORD_POLICY', async () => {
  const phone = '08093334444';
  await api().post('/api/v1/auth/signup').send({ name: 'Weak Pw', phone, email: 'weak@example.com' }).expect(201);
  const v = await api().post('/api/v1/auth/verify-otp').send({ phone, code: '123456' });
  const r = await api().post('/api/v1/auth/set-password').send({ setupToken: v.body.setupToken, password: 'short' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'PASSWORD_POLICY');
});

test('sign-in: invalid credentials, then real lockout', async () => {
  const u = await signUp();
  const good = await api().post('/api/v1/auth/sign-in').send({ identifier: u.email, password: 'Password123' });
  assert.equal(good.status, 200);
  assert.ok(good.body.accessToken);

  const bad = await api().post('/api/v1/auth/sign-in').send({ identifier: u.phone, password: 'nope' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');
  let r;
  for (let i = 0; i < 5; i += 1) r = await api().post('/api/v1/auth/sign-in').send({ identifier: u.phone, password: 'nope' });
  assert.equal(r.status, 429);
  assert.equal(r.body.error.code, 'TOO_MANY_ATTEMPTS');
  assert.ok(r.body.error.retryAfter > 0);
  // Locked even with the right password.
  const locked = await api().post('/api/v1/auth/sign-in').send({ identifier: u.phone, password: 'Password123' });
  assert.equal(locked.body.error.code, 'TOO_MANY_ATTEMPTS');
});

test('refresh rotates tokens and detects reuse', async () => {
  const u = await signUp();
  const r1 = await api().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken });
  assert.equal(r1.status, 200);
  const reuse = await api().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken });
  assert.equal(reuse.body.error.code, 'SESSION_EXPIRED');
  // Reuse revoked the whole family, including the newly issued token.
  const r2 = await api().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken });
  assert.equal(r2.body.error.code, 'SESSION_EXPIRED');
});

test('expired / invalid tokens', async () => {
  const jwt = require('jsonwebtoken');
  const expired = jwt.sign({ sub: '0'.repeat(24), typ: 'access', exp: Math.floor(Date.now() / 1000) - 10 }, 'dev-access-secret-change-me');
  const r = await api().get('/api/v1/home').set(auth(expired));
  assert.equal(r.body.error.code, 'SESSION_EXPIRED');
  const r2 = await api().get('/api/v1/home');
  assert.equal(r2.body.error.code, 'UNAUTHENTICATED');
});

test('forgot + reset password', async () => {
  const u = await signUp();
  const f = await api().post('/api/v1/auth/forgot-password').send({ identifier: u.email });
  assert.equal(f.status, 200);
  assert.ok(f.body.maskedPhone.includes('****'));
  const r = await api().post('/api/v1/auth/reset-password').send({ identifier: u.phone, code: '123456', password: 'NewPassword9' });
  assert.equal(r.status, 200);
  // Old sessions are revoked.
  const refresh = await api().post('/api/v1/auth/refresh').send({ refreshToken: u.refreshToken });
  assert.equal(refresh.body.error.code, 'SESSION_EXPIRED');
  await api().post('/api/v1/auth/sign-in').send({ identifier: u.phone, password: 'NewPassword9' }).expect(200);
});

test('bank verification failure and name lookup', async () => {
  const u = await signUp({ bank: false });
  const fail = await api().post('/api/v1/users/me/bank-account/resolve').set(auth(u.token)).send({ bankCode: '000013', accountNumber: '0123456000' });
  assert.equal(fail.status, 422);
  assert.equal(fail.body.error.code, 'BANK_VERIFICATION_FAILED');
  const ok = await api().post('/api/v1/users/me/bank-account/resolve').set(auth(u.token)).send({ bankCode: '000013', accountNumber: '0123456789' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.nameMatch, false); // mock returns "TEST ACCOUNT 6789"
});

test('no groups is an empty list, not an error', async () => {
  const u = await signUp();
  const r = await api().get('/api/v1/groups').set(auth(u.token));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.groups, []);
});
