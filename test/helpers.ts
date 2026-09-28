import './env';
import request from 'supertest';
import * as db from '../src/db';
import { createApp } from '../src/app';
import assert from 'node:assert/strict';
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

export const NGN = (n: number): number => n * 100;

export interface MemberRow { userId: string; membershipId: string }

export async function pay(token: string, cycleId: string, amount?: number, gatewayAmount?: number) {
  const r = await api().post(`/api/v1/cycles/${cycleId}/contributions`).set(auth(token)).send(amount ? { amount } : {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ref = r.body.reference;
  await api().post(`/api/v1/dev/payments/${ref}/complete`).send(gatewayAmount ? { amount: gatewayAmount } : {}).expect(200);
  const v = await api().post(`/api/v1/payments/${ref}/verify`).set(auth(token));
  assert.equal(v.status, 200);
  return { init: r.body, verify: v.body, ref };
}

/** Creates and activates a 3-member monthly group: coordinator + 2 members. */
export async function createGroup() {
  const coord = await signUp({ name: 'Grace Coordinator' });
  const m1 = await signUp({ name: 'Bola Member' });
  const m2 = await signUp({ name: 'Chidi Member' });

  let r = await api().post('/api/v1/groups').set(auth(coord.token)).send({ name: 'Unity Test Ajo', contributionAmount: NGN(50000) });
  assert.equal(r.status, 201);
  const gid = r.body.group.id;
  assert.equal(r.body.group.feeNote, 'TurnByTurn fee: 2% added on top');

  r = await api().patch(`/api/v1/groups/${gid}/draft`).set(auth(coord.token)).send({ cycleFrequency: 'monthly', firstDueDate: futureDate(10), memberCount: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.body.group.expectedCycleTotal, NGN(150000));
  assert.equal(r.body.setup.readyToActivate, false);

  // One member invited by phone (claims reserved slot), one joins by code.
  r = await api().post(`/api/v1/groups/${gid}/members`).set(auth(coord.token)).send({ phone: m1.phone });
  assert.equal(r.status, 201);
  assert.equal(r.body.membership.status, 'invited');

  const preview = await api().post('/api/v1/groups/join/preview').set(auth(m2.token)).send({ code: `TBT-${r.body.group.inviteCode}` });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.offeredPosition, 3);
  await api().post('/api/v1/groups/join').set(auth(m2.token)).send({ code: r.body.group.inviteCode }).expect(201);
  await api().post('/api/v1/groups/join').set(auth(m1.token)).send({ code: r.body.group.inviteCode }).expect(201);

  // Reorder: m1 first, coordinator second, m2 third.
  const setupView = await api().get(`/api/v1/groups/${gid}/setup`).set(auth(coord.token));
  const byUser = Object.fromEntries((setupView.body.members as MemberRow[]).map((m) => [m.userId, m.membershipId]));
  const order = [byUser[m1.user.id], byUser[coord.user.id], byUser[m2.user.id]];
  r = await api().put(`/api/v1/groups/${gid}/payout-order`).set(auth(coord.token)).send({ order });
  assert.equal(r.status, 200);
  assert.equal(r.body.setup.readyToActivate, true);

  const review = await api().get(`/api/v1/groups/${gid}/review`).set(auth(coord.token));
  assert.equal(review.body.summary.perMemberCharge.serviceFee, NGN(1000));
  assert.match(review.body.warning, /cannot change/);

  r = await api().post(`/api/v1/groups/${gid}/activate`).set(auth(coord.token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.group.status, 'active');
  return { gid, coord, m1, m2, cycleId: r.body.currentCycle.id, inviteCode: r.body.invite.code };
}

