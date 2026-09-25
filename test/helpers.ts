import './env';
import request from 'supertest';
import * as db from '../src/db';
import { createApp } from '../src/app';
import { setMockAccountName } from '../src/services/squadco';

export const app = createApp();
export const api = () => request(app);
export { db };

export async function setup(): Promise<void> {
  await db.connect();
  await db.dropDatabase();
  await db.connect(); // rebuild indexes after the drop
}

export async function teardown(): Promise<void> {
  await db.disconnect();
}

export interface TestUser {
  token: string;
  refreshToken: string;
  user: { id: string; name: string; phone: string };
  phone: string;
  email: string;
}

let seq = 0;

/** Runs the full 4-step onboarding and returns the signed-in user. */
export async function signUp({ name = 'Test User', bank = true }: { name?: string; bank?: boolean } = {}): Promise<TestUser> {
  seq += 1;
  const n = String(Date.now() % 1e6).padStart(6, '0') + String(seq).padStart(2, '0');
  const phone = `0803${n.slice(-7)}`;
  const email = `user${n}@example.com`;
  let r = await api().post('/api/v1/auth/signup').send({ name, phone, email });
  if (r.status !== 201) throw new Error(`signup ${r.status} ${JSON.stringify(r.body)}`);
  r = await api().post('/api/v1/auth/verify-otp').send({ phone, code: '123456' });
  if (r.status !== 200) throw new Error(`verify ${r.status} ${JSON.stringify(r.body)}`);
  r = await api()
    .post('/api/v1/auth/set-password')
    .send({ setupToken: r.body.setupToken, password: 'Password123', confirmPassword: 'Password123' });
  if (r.status !== 201) throw new Error(`password ${r.status} ${JSON.stringify(r.body)}`);
  const token: string = r.body.accessToken;
  const out: TestUser = { token, user: r.body.user, phone: r.body.user.phone, email, refreshToken: r.body.refreshToken };
  if (bank) {
    const acct = `01${n.slice(-8)}`;
    setMockAccountName(acct, name.toUpperCase());
    const b = await api().put('/api/v1/users/me/bank-account').set(auth(token)).send({ bankCode: '000013', accountNumber: acct });
    if (b.status !== 200) throw new Error(`bank ${b.status} ${JSON.stringify(b.body)}`);
  }
  return out;
}

export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

export function futureDate(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}
