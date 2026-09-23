'use strict';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/turnbyturn_test';
process.env.OTP_DEV_FIXED_CODE = '123456';
process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';
process.env.SQUADCO_MOCK = 'true';
process.env.SQUADCO_SECRET_KEY = '';

const request = require('supertest');
const db = require('../src/db');
const { createApp } = require('../src/app');

const app = createApp();
const api = () => request(app);

async function setup() {
  await db.connect();
  await db.mongoose.connection.db.dropDatabase();
  await db.connect(); // rebuild indexes after the drop
}

async function teardown() {
  await db.disconnect();
}

let seq = 0;
/** Runs the full 4-step onboarding and returns { token, user, phone }. */
async function signUp({ name = 'Test User', bank = true } = {}) {
  seq += 1;
  const n = String(Date.now() % 1e6).padStart(6, '0') + String(seq).padStart(2, '0');
  const phone = `0803${n.slice(-7)}`;
  const email = `user${n}@example.com`;
  let r = await api().post('/api/v1/auth/signup').send({ name, phone, email });
  if (r.status !== 201) throw new Error(`signup ${r.status} ${JSON.stringify(r.body)}`);
  r = await api().post('/api/v1/auth/verify-otp').send({ phone, code: '123456' });
  if (r.status !== 200) throw new Error(`verify ${r.status} ${JSON.stringify(r.body)}`);
  r = await api().post('/api/v1/auth/set-password').send({ setupToken: r.body.setupToken, password: 'Password123', confirmPassword: 'Password123' });
  if (r.status !== 201) throw new Error(`password ${r.status} ${JSON.stringify(r.body)}`);
  const token = r.body.accessToken;
  const out = { token, user: r.body.user, phone: r.body.user.phone, email, refreshToken: r.body.refreshToken };
  if (bank) {
    const acct = `01${n.slice(-8)}`;
    require('../src/services/squadco').setMockAccountName(acct, name.toUpperCase());
    const b = await api().put('/api/v1/users/me/bank-account').set('Authorization', `Bearer ${token}`).send({ bankCode: '000013', accountNumber: acct });
    if (b.status !== 200) throw new Error(`bank ${b.status} ${JSON.stringify(b.body)}`);
  }
  return out;
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

function futureDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

module.exports = { app, api, setup, teardown, signUp, auth, futureDate, db };
