/** Product changes from the Flutter/design review (recipient payouts, Home savings, preferred name, activity). */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, setup, teardown, signUp, auth, pay, createGroup, NGN } from './helpers';
import { Payout } from '../src/models';

before(setup);
after(teardown);

interface PayoutRow {
  id: string;
  status: string;
  recipient: { id: string } | null;
  viewerIsRecipient: boolean;
  viewerCanStart: boolean;
}

const home = async (token: string) => (await api().get('/api/v1/home').set(auth(token))).body;

test('recipient starts their own eligible payout; other members cannot', async () => {
  // Turn order: m1 → coordinator → m2. Cycle 1 pays out to m1.
  const { gid, coord, m1, m2, cycleId } = await createGroup();

  // Home before anyone pays: m1's turn is this cycle but it isn't funded yet.
  let h = await home(m1.token);
  assert.equal(h.savings.nextPayout.state, 'blocked');
  assert.equal(h.savings.nextPayout.position, 1);
  assert.equal(h.savings.nextPayout.amount, NGN(150000));
  assert.equal(h.savings.nextPayout.collected, 0);
  assert.equal(h.savings.nextPayout.canStart, false);
  assert.equal(h.savings.currentCycle.status, 'unpaid');

  // m2's turn is two cycles away.
  const h2 = await home(m2.token);
  assert.equal(h2.savings.nextPayout.state, 'upcoming');
  assert.equal(h2.savings.nextPayout.payoutId, null);
  assert.equal(h2.savings.nextPayout.position, 3);
  assert.equal(h2.savings.nextPayout.cyclesAway, 2);
  assert.ok(h2.savings.nextPayout.expectedDate);

  // m1 pays in two parts: current-cycle progress is partial, totals exclude the 2% fee.
  await pay(m1.token, cycleId, NGN(20000));
  h = await home(m1.token);
  assert.equal(h.savings.currentCycle.status, 'partial');
  assert.equal(h.savings.currentCycle.amountPaid, NGN(20000));
  assert.equal(h.savings.currentCycle.outstanding, NGN(30000));
  assert.equal(h.savings.currentCycle.percentPaid, 40);
  assert.equal(h.savings.totalConfirmedContributions, NGN(20000));
  assert.equal(h.savings.totalServiceFeesPaid, NGN(400));
  await pay(m1.token, cycleId);
  await pay(coord.token, cycleId);
  await pay(m2.token, cycleId);

  // Cycle funded: m1 sees Eligible with the Payout button.
  h = await home(m1.token);
  assert.equal(h.savings.nextPayout.state, 'eligible');
  assert.equal(h.savings.nextPayout.canStart, true);
  assert.equal(h.savings.nextPayout.bankAccountReady, true);
  assert.equal(h.savings.totalConfirmedContributions, NGN(50000));
  const payoutId: string = h.savings.nextPayout.payoutId;

  // Viewer flags on the payout object.
  const asRecipient = (await api().get(`/api/v1/payouts/${payoutId}`).set(auth(m1.token))).body.payout as PayoutRow;
  assert.equal(asRecipient.viewerIsRecipient, true);
  assert.equal(asRecipient.viewerCanStart, true);
  const asOther = (await api().get(`/api/v1/payouts/${payoutId}`).set(auth(m2.token))).body.payout as PayoutRow;
  assert.equal(asOther.viewerIsRecipient, false);
  assert.equal(asOther.viewerCanStart, false);
  const asCoord = (await api().get(`/api/v1/groups/${gid}/payouts`).set(auth(coord.token))).body.payouts[0] as PayoutRow;
  assert.equal(asCoord.viewerCanStart, true);

  // Another member may not start it.
  const denied = await api().post(`/api/v1/payouts/${payoutId}/start`).set(auth(m2.token));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'ACCESS_DENIED');

  // The recipient starts it themselves.
  const started = await api().post(`/api/v1/payouts/${payoutId}/start`).set(auth(m1.token));
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.payout.status, 'sent');
  assert.equal(started.body.payout.viewerCanStart, false);

  // Home now shows Payout sent, and the lifetime payout total.
  h = await home(m1.token);
  assert.equal(h.savings.nextPayout.state, 'sent');
  assert.equal(h.savings.nextPayout.amount, NGN(150000));
  assert.ok(h.savings.nextPayout.sentAt);
  assert.match(h.savings.nextPayout.reference, /^PAY-\d{4}-\d{4}$/);
  assert.equal(h.savings.totalPayoutsReceived, NGN(150000));
  assert.equal(h.savings.payoutsReceivedCount, 1);
  // The next cycle opened, so the user's current-cycle progress resets to unpaid.
  assert.equal(h.savings.currentCycle.status, 'unpaid');

  // Starting it again is rejected by the state machine.
  const again = await api().post(`/api/v1/payouts/${payoutId}/start`).set(auth(m1.token));
  assert.equal(again.body.error.code, 'PAYOUT_NOT_ELIGIBLE');

  // Once the sent payout is older than the visibility window it drops off Home.
  await Payout.updateOne({ _id: payoutId }, { $set: { sentAt: new Date(Date.now() - 30 * 86400000) } });
  h = await home(m1.token);
  assert.equal(h.savings.nextPayout, null); // m1 has no further turns in this group
  assert.equal(h.savings.totalPayoutsReceived, NGN(150000));

  // Coordinator's own turn (cycle 2) is now blocked, and the coordinator can still start
  // someone else's payout on their behalf.
  const hc = await home(coord.token);
  assert.equal(hc.savings.nextPayout.state, 'blocked');
  assert.equal(hc.savings.nextPayout.position, 2);
});

test('coordinator can still start a payout on the recipient’s behalf', async () => {
  const { coord, m1, m2, cycleId } = await createGroup();
  for (const u of [m1, coord, m2]) await pay(u.token, cycleId);
  const payoutId = (await home(m1.token)).savings.nextPayout.payoutId as string;
  const r = await api().post(`/api/v1/payouts/${payoutId}/start`).set(auth(coord.token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.payout.status, 'sent');
  assert.equal(r.body.payout.viewerIsRecipient, false);
});

test('preferred name: set, used as displayName, cleared', async () => {
  const u = await signUp({ name: 'Adaeze Nkechi Obi' });
  let me = await api().get('/api/v1/users/me').set(auth(u.token));
  assert.equal(me.body.user.preferredName, undefined);
  assert.equal(me.body.user.displayName, 'Adaeze');

  let r = await api().patch('/api/v1/users/me').set(auth(u.token)).send({ preferredName: '  Ada  ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.preferredName, 'Ada');
  assert.equal(r.body.user.displayName, 'Ada');
  assert.equal(r.body.user.name, 'Adaeze Nkechi Obi'); // legal name untouched

  const h = await home(u.token);
  assert.equal(h.user.preferredName, 'Ada');
  assert.equal(h.user.displayName, 'Ada');

  const tooLong = await api().patch('/api/v1/users/me').set(auth(u.token)).send({ preferredName: 'x'.repeat(41) });
  assert.equal(tooLong.body.error.code, 'VALIDATION_ERROR');

  r = await api().patch('/api/v1/users/me').set(auth(u.token)).send({ preferredName: null });
  assert.equal(r.body.user.preferredName, undefined);
  me = await api().get('/api/v1/users/me').set(auth(u.token));
  assert.equal(me.body.user.displayName, 'Adaeze');
});

test('announcements appear inside the shared Activity feed', async () => {
  const { gid, coord, m1 } = await createGroup();
  const posted = await api()
    .post(`/api/v1/groups/${gid}/announcements`)
    .set(auth(coord.token))
    .send({ title: 'Meeting on Friday', body: 'We meet at 5pm to agree the new rules.' });
  assert.equal(posted.status, 201);

  const feed = await api().get(`/api/v1/groups/${gid}/activity`).set(auth(m1.token));
  assert.equal(feed.status, 200);
  interface Item { eventType: string; announcement: { title: string; body: string; authorName: string } | null }
  const items = feed.body.activity as Item[];
  const ann = items.find((a) => a.eventType === 'announcement');
  assert.ok(ann?.announcement);
  assert.equal(ann.announcement.title, 'Meeting on Friday');
  assert.equal(ann.announcement.body, 'We meet at 5pm to agree the new rules.');
  assert.equal(ann.announcement.authorName, 'Grace Coordinator');
  // Non-announcement events carry announcement: null.
  assert.ok(items.some((a) => a.eventType !== 'announcement' && a.announcement === null));

  const onlyAnn = await api().get(`/api/v1/groups/${gid}/activity?eventType=announcement`).set(auth(m1.token));
  assert.deepEqual([...new Set((onlyAnn.body.activity as Item[]).map((a) => a.eventType))], ['announcement']);
  const bad = await api().get(`/api/v1/groups/${gid}/activity?eventType=DROP;`).set(auth(m1.token));
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
});
