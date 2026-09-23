'use strict';

/**
 * Seeds realistic fixture data for the Flutter team:
 *   - "Unity Women's Ajo": ₦50,000 × 10 members, monthly, 2% fee. Cycle 1 paid out; cycle 2 in
 *     progress with a mix of paid / part-paid / unpaid members.
 *   - "Family Circle": ₦20,000 × 4, weekly, where Unity's coordinator is a plain member
 *     (demonstrates per-group roles).
 *   - A staff admin account.
 *
 * Every account's password is "Password123". Run with `npm run seed` (refuses in production
 * unless SEED_FORCE=true). Wipes the target database first.
 */

process.env.SQUADCO_MOCK = process.env.SQUADCO_MOCK || 'true';

const bcrypt = require('bcryptjs');
const { config, assertConfig } = require('../config/env');
const db = require('../db');
const { User, Group, Membership, PaymentAttempt, Contribution, Payout, Announcement, Cycle } = require('../models');
const { uniqueInviteCode } = require('../services/groups');
const cycles = require('../services/cycles');
const payments = require('../services/payments');
const payouts = require('../services/payouts');
const { logActivity } = require('../services/notify');
const { nextReference } = require('../services/references');
const { breakdown } = require('../utils/money');
const { addMonthsClamped } = require('../utils/dates');

const NGN = (n) => n * 100;

const PEOPLE = [
  ['Ngozi Okafor', '+2348031000001', '000013', '0123000001'],
  ['Amaka Eze', '+2348031000002', '000014', '0123000002'],
  ['Funke Adeyemi', '+2348031000003', '000015', '0123000003'],
  ['Halima Bello', '+2348031000004', '000016', '0123000004'],
  ['Chiamaka Nwosu', '+2348031000005', '000004', '0123000005'],
  ['Kemi Balogun', '+2348031000006', '000013', '0123000006'],
  ['Zainab Musa', '+2348031000007', '090405', '0123000007'],
  ['Blessing Okon', '+2348031000008', '100004', '0123000008'],
  ['Adaeze Obi', '+2348031000009', '000017', '0123000009'],
  ['Yetunde Ajayi', '+2348031000010', '000007', '0123000010'],
  ['Tunde Okafor', '+2348031000011', '000013', '0123000011'],
  ['Chinedu Okafor', '+2348031000012', '000014', '0123000012'],
  ['Ifeoma Okafor', '+2348031000013', '000015', '0123000013'],
];

async function payFor(user, cycle, amount, overrideReceived) {
  const membership = await Membership.findOne({ groupId: cycle.groupId, userId: user._id });
  const contribution = await Contribution.findOne({ cycleId: cycle._id, membershipId: membership._id });
  const group = await Group.findById(cycle.groupId);
  const q = breakdown(amount, group.platformFeeBps);
  const reference = await nextReference('TRX');
  await PaymentAttempt.create({
    reference,
    contributionId: contribution._id,
    cycleId: cycle._id,
    groupId: group._id,
    userId: user._id,
    kind: amount === contribution.amountDue - contribution.amountPaid ? 'full' : 'partial',
    amount,
    serviceFee: q.serviceFee,
    totalCharged: q.total,
  });
  await payments.applyPaymentOutcome(reference, { status: 'success', amountKobo: overrideReceived || q.total, channel: 'Card' });
  return reference;
}

async function makeGroup({ name, description, coordinator, members, amount, frequency, firstDueDate, rules }) {
  const group = await Group.create({
    name,
    description,
    coordinatorId: coordinator._id,
    contributionAmount: amount,
    memberCount: members.length,
    cycleFrequency: frequency,
    firstDueDate,
    platformFeeBps: config.money.platformFeeBps,
    inviteCode: await uniqueInviteCode(),
    rules,
    createdAt: new Date(firstDueDate.getTime() - 20 * 86400000),
  });
  const order = [];
  for (const u of members) {
    const m = await Membership.create({
      groupId: group._id,
      userId: u._id,
      role: String(u._id) === String(coordinator._id) ? 'coordinator' : 'member',
      status: 'joined',
      joinedAt: new Date(firstDueDate.getTime() - 15 * 86400000),
      payoutPosition: order.length + 1,
    });
    order.push(m._id);
  }
  if (!members.some((u) => String(u._id) === String(coordinator._id))) {
    await Membership.create({ groupId: group._id, userId: coordinator._id, role: 'coordinator', participant: false, status: 'joined', joinedAt: new Date() });
  }
  group.payoutOrder = order;
  group.status = 'active';
  group.activatedAt = new Date(firstDueDate.getTime() - 10 * 86400000);
  await group.save();
  await logActivity(group._id, coordinator._id, 'group_activated', `${coordinator.name} started the group. Amount and turn order are now locked.`);
  const cycle = await cycles.openCycle(group, 1);
  return { group, cycle };
}

async function main() {
  assertConfig();
  if (config.isProd && process.env.SEED_FORCE !== 'true') throw new Error('Refusing to seed a production database (set SEED_FORCE=true)');
  await db.connect();
  await db.mongoose.connection.db.dropDatabase();
  await db.connect();

  const passwordHash = await bcrypt.hash('Password123', 10);
  const squadco = require('../services/squadco');
  const users = [];
  for (const [name, phone, bankCode, accountNumber] of PEOPLE) {
    squadco.setMockAccountName(accountNumber, name.toUpperCase());
    users.push(
      await User.create({
        name,
        phone,
        email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
        passwordHash,
        status: 'active',
        phoneVerifiedAt: new Date(),
        bankAccount: {
          bankCode,
          bankName: squadco.bankByCode(bankCode).name,
          accountNumber,
          accountName: name.toUpperCase(),
          verified: true,
          nameMatch: true,
          verifiedAt: new Date(),
        },
        trustedContact: { name: 'Next of Kin', phone: '+2348099999999', relationship: 'Sibling' },
        lastLoginAt: new Date(),
      }),
    );
  }
  const admin = await User.create({
    name: 'TurnByTurn Support',
    phone: '+2348030000000',
    email: 'support@turnbyturn.app',
    passwordHash,
    status: 'active',
    isAdmin: true,
    phoneVerifiedAt: new Date(),
  });

  // ---------------------------------------------------------------- Unity Women's Ajo
  const [ngozi] = users;
  const unityMembers = users.slice(0, 10);
  const firstDue = addMonthsClamped(new Date(), -1);
  firstDue.setUTCHours(22, 59, 0, 0); // 23:59 Lagos
  const unity = await makeGroup({
    name: "Unity Women's Ajo",
    description: 'Monthly savings circle for the Unity Market women’s association.',
    coordinator: ngozi,
    members: unityMembers,
    amount: NGN(50000),
    frequency: 'monthly',
    firstDueDate: firstDue,
    rules: [
      'Contributions are due by 11:59pm on the due date.',
      'Payout goes to the member whose turn it is once everyone has paid.',
      'Speak to the coordinator early if you will be late.',
    ],
  });

  // Cycle 1: everyone pays (one in two parts), payout released.
  for (const u of unityMembers) {
    if (u === users[4]) {
      await payFor(u, unity.cycle, NGN(30000));
      await payFor(u, unity.cycle, NGN(20000));
    } else {
      await payFor(u, unity.cycle, NGN(50000));
    }
  }
  const payout1 = await Payout.findOne({ cycleId: unity.cycle._id });
  await payouts.startPayout(payout1._id, ngozi._id);

  // Cycle 2 (opened automatically): 6 paid, 1 part-paid, 1 overpaid (reconciliation), 2 unpaid.
  const cycle2 = await Cycle.findOne({ groupId: unity.group._id, cycleNumber: 2 });
  for (const u of unityMembers.slice(0, 6)) await payFor(u, cycle2, NGN(50000));
  await payFor(users[6], cycle2, NGN(20000));
  await payFor(users[7], cycle2, NGN(50000), NGN(61000)); // gateway confirmed ₦10,000 extra

  await Announcement.create({
    groupId: unity.group._id,
    authorId: ngozi._id,
    title: 'Welcome to the September cycle',
    body: 'Thank you all for paying on time last month! Please remember the due date and reach out if you need help.',
  });

  // ---------------------------------------------------------------- Family Circle (Ngozi is a member)
  const tunde = users[10];
  const familyMembers = [tunde, ngozi, users[11], users[12]];
  const famDue = new Date(Date.now() + 5 * 86400000);
  famDue.setUTCHours(22, 59, 0, 0);
  const family = await makeGroup({
    name: 'Family Circle',
    description: 'Okafor family weekly contribution.',
    coordinator: tunde,
    members: familyMembers,
    amount: NGN(20000),
    frequency: 'weekly',
    firstDueDate: famDue,
    rules: ['Pay before Sunday evening.'],
  });
  await payFor(tunde, family.cycle, NGN(20000));

  // ---------------------------------------------------------------- A draft group mid-setup
  const draft = await Group.create({
    name: 'Office Savings Club',
    coordinatorId: users[2]._id,
    contributionAmount: NGN(25000),
    cycleFrequency: 'biweekly',
    memberCount: 6,
    platformFeeBps: config.money.platformFeeBps,
    inviteCode: await uniqueInviteCode(),
  });
  const dm = await Membership.create({ groupId: draft._id, userId: users[2]._id, role: 'coordinator', status: 'joined', joinedAt: new Date(), payoutPosition: 1 });
  draft.payoutOrder = [dm._id];
  await draft.save();

  console.info('\nSeeded:');
  console.info(`  Unity Women's Ajo  invite ${unity.group.inviteCode}  (coordinator: ${ngozi.name} ${ngozi.phone})`);
  console.info(`  Family Circle      invite ${family.group.inviteCode}  (coordinator: ${tunde.name}; ${ngozi.name} is a member)`);
  console.info(`  Office Savings Club (draft) invite ${draft.inviteCode}`);
  console.info(`  Admin: ${admin.email}`);
  console.info('  Password for every account: Password123\n');
  await db.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.disconnect().catch(() => {});
  process.exit(1);
});
