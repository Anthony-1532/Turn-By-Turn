import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setup, teardown, signUp, auth, futureDate } from './helpers';
import { User, Cycle, Transaction } from '../src/models';

interface MemberRow { userId: string; membershipId: string }
interface TxRow { type: string }
import * as cyclesSvc from '../src/services/cycles';
import { setMockAccountName } from '../src/services/squadco';

before(setup);
after(teardown);

const NGN = (n: number): number => n * 100;

async function pay(token: string, cycleId: string, amount?: number, gatewayAmount?: number) {
  const r = await api().post(`/api/v1/cycles/${cycleId}/contributions`).set(auth(token)).send(amount ? { amount } : {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ref = r.body.reference;
  await api().post(`/api/v1/dev/payments/${ref}/complete`).send(gatewayAmount ? { amount: gatewayAmount } : {}).expect(200);
  const v = await api().post(`/api/v1/payments/${ref}/verify`).set(auth(token));
  assert.equal(v.status, 200);
  return { init: r.body, verify: v.body, ref };
}

/** Creates and activates a 3-member monthly group: coordinator + 2 members. */
async function createGroup() {
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

test('full rotation: create, pay (full + partial), payout, next cycle', async () => {
  const { gid, coord, m1, m2, cycleId } = await createGroup();

  // Locked after activation.
  const locked = await api().patch(`/api/v1/groups/${gid}/draft`).set(auth(coord.token)).send({ contributionAmount: NGN(1000) });
  assert.equal(locked.body.error.code, 'GROUP_NOT_DRAFT');
  const late = await signUp();
  const full = await api().post('/api/v1/groups/join').set(auth(late.token)).send({ code: (await api().get(`/api/v1/groups/${gid}/invite`).set(auth(coord.token))).body.code });
  assert.equal(full.body.error.code, 'GROUP_FULL');

  // Members can't use coordinator endpoints.
  const denied = await api().get(`/api/v1/groups/${gid}/dashboard`).set(auth(m2.token));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'ACCESS_DENIED');
  const outsider = await api().get(`/api/v1/groups/${gid}`).set(auth(late.token));
  assert.equal(outsider.body.error.code, 'ACCESS_DENIED');

  // Quote shows 2% on top.
  const q = await api().get(`/api/v1/cycles/${cycleId}/contributions/quote?amount=${NGN(20000)}`).set(auth(m2.token));
  assert.deepEqual(
    { c: q.body.quote.contribution, f: q.body.quote.serviceFee, t: q.body.quote.total, k: q.body.quote.kind },
    { c: NGN(20000), f: NGN(400), t: NGN(20400), k: 'partial' },
  );
  const over = await api().post(`/api/v1/cycles/${cycleId}/contributions`).set(auth(m2.token)).send({ amount: NGN(60000) });
  assert.equal(over.body.error.code, 'AMOUNT_INVALID');

  // m1 & coordinator pay in full.
  let p = await pay(m1.token, cycleId);
  assert.equal(p.verify.result, 'full_payment_received');
  assert.match(p.ref, /^TRX-\d{4}-\d{4}$/);
  await pay(coord.token, cycleId);

  // m2 pays in two parts.
  p = await pay(m2.token, cycleId, NGN(20000));
  assert.equal(p.verify.result, 'partial_payment_received');
  assert.equal(p.verify.contribution.outstandingAmount, NGN(30000));

  let payoutView = await api().get(`/api/v1/groups/${gid}/cycles/current`).set(auth(coord.token));
  assert.equal(payoutView.body.payout.status, 'blocked');
  assert.equal(payoutView.body.payout.outstandingAmount, NGN(30000));
  assert.equal(payoutView.body.payout.blockingMembers.length, 1);
  const start = await api().post(`/api/v1/payouts/${payoutView.body.payout.id}/start`).set(auth(coord.token));
  assert.equal(start.body.error.code, 'PAYOUT_NOT_ELIGIBLE');

  // Webhook replay of the same reference must not double-credit.
  await api().post(`/api/v1/dev/payments/${p.ref}/complete`).send({}).expect(200);

  p = await pay(m2.token, cycleId);
  assert.equal(p.verify.result, 'full_payment_received');
  const my = await api().get(`/api/v1/cycles/${cycleId}/my-contribution`).set(auth(m2.token));
  assert.equal(my.body.payments.length, 2);

  // Cycle complete → payout eligible, next cycle opened.
  const cycle = await Cycle.findById(cycleId);
  assert.ok(cycle);
  assert.equal(cycle.status, 'complete');
  assert.equal(cycle.confirmedReceived, NGN(150000));
  payoutView = await api().get(`/api/v1/groups/${gid}/payouts`).set(auth(coord.token));
  const first = payoutView.body.payouts[0];
  assert.equal(first.status, 'eligible');
  assert.equal(first.recipient.id, m1.user.id);
  assert.equal(first.confirmedAmount, NGN(150000)); // fee never deducted from payout

  // Only the coordinator can start it.
  const memberStart = await api().post(`/api/v1/payouts/${first.id}/start`).set(auth(m2.token));
  assert.equal(memberStart.body.error.code, 'ACCESS_DENIED');
  const started = await api().post(`/api/v1/payouts/${first.id}/start`).set(auth(coord.token));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.payout.status, 'sent');

  const cycles = await api().get(`/api/v1/groups/${gid}/cycles`).set(auth(m1.token));
  assert.equal(cycles.body.cycles.length, 2);
  assert.equal(cycles.body.cycles[1].periodLabel.endsWith('cycle'), true);

  // History: m1 sees contribution + fee (debit) and payout (credit), grouped by month.
  const hist = await api().get('/api/v1/transactions').set(auth(m1.token));
  const all = (hist.body.months as Array<{ transactions: TxRow[] }>).flatMap((m) => m.transactions);
  assert.deepEqual(all.map((t) => t.type).sort(), ['contribution', 'fee', 'payout']);
  const onlyPayouts = await api().get('/api/v1/transactions?type=payout&status=success').set(auth(m1.token));
  assert.equal(onlyPayouts.body.count, 1);
  const byGroup = await api().get(`/api/v1/transactions?groupId=${gid}`).set(auth(m2.token));
  assert.equal(byGroup.body.count, 4);

  // Receipt
  const receipt = await api().get(`/api/v1/payments/${p.ref}/receipt`).set(auth(m2.token));
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.receipt.group.name, 'Unity Test Ajo');
  assert.equal(receipt.body.receipt.cycleBalance.outstanding, 0);

  // Home + notifications + activity
  const home = await api().get('/api/v1/home').set(auth(m1.token));
  assert.equal(home.body.summary.groupCount, 1);
  const notes = await api().get('/api/v1/notifications').set(auth(m1.token));
  assert.ok((notes.body.notifications as Array<{ type: string }>).some((n) => n.type === 'payout_sent'));
  const act = await api().get(`/api/v1/groups/${gid}/activity`).set(auth(m2.token));
  assert.ok((act.body.activity as Array<{ eventType: string }>).some((a) => a.eventType === 'payout_sent'));

  // Turn order view is locked.
  const order = await api().get(`/api/v1/groups/${gid}/payout-order`).set(auth(m2.token));
  assert.equal(order.body.locked, true);
  assert.equal(order.body.order[0].payoutStatus, 'sent');
});

test('overpayment → reconciliation required → review submitted → admin resolves', async () => {
  const { coord, m1, cycleId } = await createGroup();
  // Gateway confirms ₦61,200 for a ₦51,000 checkout: ₦10,200 excess.
  const p = await pay(m1.token, cycleId, undefined, NGN(61200));
  assert.equal(p.verify.result, 'reconciliation_required');
  const contribution = p.verify.contribution;
  assert.equal(contribution.excessAmount, NGN(10200));
  assert.equal(contribution.amountPaid, NGN(50000));

  const sub = await api().post(`/api/v1/contributions/${contribution.id}/reconcile`).set(auth(m1.token)).send({ note: 'Charged twice?' });
  assert.equal(sub.status, 201);
  assert.equal(sub.body.status, 'review_submitted');

  // Admin
  await User.updateOne({ _id: coord.user.id }, { $set: { isAdmin: true } });
  const tickets = await api().get('/api/v1/admin/tickets?kind=reconciliation').set(auth(coord.token));
  assert.equal(tickets.body.tickets.length, 1);
  const res = await api().post(`/api/v1/admin/contributions/${contribution.id}/reconciliation`).set(auth(coord.token)).send({ action: 'refunded', note: 'Refunded via Squadco dashboard' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.contribution.status, 'paid');
  assert.equal(res.body.adjustment.type, 'refund');

  // Original transaction preserved with the gateway amount.
  const original = await Transaction.findOne({ reference: p.ref, type: 'contribution' });
  assert.ok(original);
  assert.equal(original.amount, NGN(60200)); // ₦61,200 received − ₦1,000 fee
  assert.equal(original.meta.gatewayAmountReceived, NGN(61200));
  assert.equal(original.meta.excess, NGN(10200));
  assert.equal(original.status, 'success');
  await User.updateOne({ _id: coord.user.id }, { $set: { isAdmin: false } });
});

test('overdue → resolution required → admin extends; reminders are rate-limited', async () => {
  const { gid, coord, m1, cycleId } = await createGroup();
  await pay(m1.token, cycleId);

  const r1 = await api().post(`/api/v1/groups/${gid}/reminders`).set(auth(coord.token)).send({});
  assert.equal(r1.status, 201);
  assert.equal(r1.body.sentCount, 2); // coordinator + m2 still owe
  const r2 = await api().post(`/api/v1/groups/${gid}/reminders`).set(auth(coord.token)).send({});
  assert.equal(r2.status, 429);
  assert.equal(r2.body.error.code, 'REMINDER_COOLDOWN');

  // Jump past the due date.
  await Cycle.updateOne({ _id: cycleId }, { $set: { dueDate: new Date(Date.now() - 3 * 86400000) } });
  assert.equal(await cyclesSvc.markOverdueCycles(), 1);
  let status = await api().get(`/api/v1/groups/${gid}/cycles/current`).set(auth(m1.token));
  assert.equal(status.body.cycle.status, 'overdue');
  assert.equal(status.body.outstandingMembers.length, 2);
  assert.equal(status.body.payout.status, 'blocked');

  await Cycle.updateOne({ _id: cycleId }, { $set: { overdueAt: new Date(Date.now() - 8 * 86400000) } });
  assert.equal(await cyclesSvc.escalateStuckCycles(), 1);
  status = await api().get(`/api/v1/groups/${gid}/cycles/current`).set(auth(m1.token));
  assert.equal(status.body.cycle.status, 'resolution_required');

  // Payments are still accepted while overdue.
  const q = await api().get(`/api/v1/cycles/${cycleId}/contributions/quote`).set(auth(coord.token));
  assert.equal(q.status, 200);

  const ticket = await api().post(`/api/v1/cycles/${cycleId}/support`).set(auth(m1.token)).send({ message: 'What happens now?' });
  assert.equal(ticket.status, 201);

  await User.updateOne({ _id: coord.user.id }, { $set: { isAdmin: true } });
  const ext = await api().post(`/api/v1/admin/cycles/${cycleId}/resolve`).set(auth(coord.token)).send({ action: 'extend_deadline', note: 'Agreed with group', newDueDate: futureDate(5) });
  assert.equal(ext.status, 200, JSON.stringify(ext.body));
  assert.equal(ext.body.cycle.status, 'open');
  await User.updateOne({ _id: coord.user.id }, { $set: { isAdmin: false } });
});

test('failed payout → delayed recovery → sent', async () => {
  const coord = await signUp({ name: 'Fola Coord' });
  const m = await signUp({ name: 'Gbenga Member', bank: false });
  // Mock transfer fails for accounts ending 999.
  setMockAccountName('0100000999', 'GBENGA MEMBER');
  await api().put('/api/v1/users/me/bank-account').set(auth(m.token)).send({ bankCode: '000015', accountNumber: '0100000999' }).expect(200);

  let r = await api().post('/api/v1/groups').set(auth(coord.token)).send({ name: 'Pair Ajo', contributionAmount: NGN(10000), coordinatorParticipates: true });
  const gid = r.body.group.id;
  await api().patch(`/api/v1/groups/${gid}/draft`).set(auth(coord.token)).send({ cycleFrequency: 'weekly', firstDueDate: futureDate(3), memberCount: 2 }).expect(200);
  await api().post('/api/v1/groups/join').set(auth(m.token)).send({ code: r.body.group.inviteCode }).expect(201);
  const sv = await api().get(`/api/v1/groups/${gid}/setup`).set(auth(coord.token));
  const ids = Object.fromEntries((sv.body.members as MemberRow[]).map((x) => [x.userId, x.membershipId]));
  await api().put(`/api/v1/groups/${gid}/payout-order`).set(auth(coord.token)).send({ order: [ids[m.user.id], ids[coord.user.id]] }).expect(200);
  r = await api().post(`/api/v1/groups/${gid}/activate`).set(auth(coord.token)).expect(200);
  const cycleId = r.body.currentCycle.id;
  assert.equal(r.body.currentCycle.periodLabel, 'Cycle 1');

  await pay(coord.token, cycleId);
  await pay(m.token, cycleId);
  const list = await api().get(`/api/v1/groups/${gid}/payouts`).set(auth(coord.token));
  const payoutId = list.body.payouts[0].id;
  r = await api().post(`/api/v1/payouts/${payoutId}/start`).set(auth(coord.token));
  assert.equal(r.body.payout.status, 'failed');
  assert.match(r.body.payout.failureReason, /unavailable/);

  // Member fixes their account; staff retry.
  setMockAccountName('0100000123', 'GBENGA MEMBER');
  await api().put('/api/v1/users/me/bank-account').set(auth(m.token)).send({ bankCode: '000015', accountNumber: '0100000123' }).expect(200);
  const nonAdmin = await api().post(`/api/v1/admin/payouts/${payoutId}/retry`).set(auth(coord.token));
  assert.equal(nonAdmin.status, 403);
  await User.updateOne({ _id: coord.user.id }, { $set: { isAdmin: true } });
  r = await api().post(`/api/v1/admin/payouts/${payoutId}/retry`).set(auth(coord.token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.payout.status, 'sent');
  assert.equal(r.body.payout.attempts.length, 2);
  const tx = await Transaction.find({ payoutId, type: 'payout' }).sort({ createdAt: 1 });
  assert.deepEqual(tx.map((t) => t.status), ['failed', 'success']);
  await User.updateOne({ _id: coord.user.id }, { $set: { isAdmin: false } });

  // Second (last) cycle completes the group.
  const c2 = (await api().get(`/api/v1/groups/${gid}/cycles/current`).set(auth(coord.token))).body.cycle;
  assert.equal(c2.cycleNumber, 2);
  await pay(coord.token, c2.id);
  await pay(m.token, c2.id);
  const pay2 = (await api().get(`/api/v1/groups/${gid}/payouts`).set(auth(coord.token))).body.payouts[1];
  await api().post(`/api/v1/payouts/${pay2.id}/start`).set(auth(coord.token)).expect(200);
  const g = await api().get(`/api/v1/groups/${gid}`).set(auth(m.token));
  assert.equal(g.body.group.status, 'completed');
});

test('squadco webhook: signature check and idempotency', async () => {
  const { m1, cycleId } = await createGroup();
  const r = await api().post(`/api/v1/cycles/${cycleId}/contributions`).set(auth(m1.token)).send({});
  const ref = r.body.reference;
  const body = JSON.stringify({ Event: 'charge_successful', TransactionRef: ref, Body: { amount: NGN(51000), transaction_ref: ref, transaction_status: 'Success', transaction_type: 'Card' } });
  const send = () => api().post('/api/v1/webhooks/squadco').set('Content-Type', 'application/json').send(body);
  const first = await send();
  assert.equal(first.status, 200);
  const dup = await send();
  assert.equal(dup.body.duplicate, true);
  const c = await Cycle.findById(cycleId);
  assert.ok(c);
  assert.equal(c.confirmedReceived, NGN(50000));
});
