'use strict';

const { User, Notification, ActivityLog } = require('../models');
const { sendPush } = require('./push');
const { sendEmail, layout, escapeHtml } = require('./zeptomail');
const { sendSms } = require('./squadco');

/**
 * Preference bucket each notification type belongs to; users can mute a bucket in
 * Profile → Notifications. Security-relevant types have no bucket and are always delivered.
 */
const CATEGORY = {
  payment_received: 'payoutUpdates',
  partial_payment_received: 'payoutUpdates',
  payment_reminder: 'paymentReminders',
  cycle_overdue: 'paymentReminders',
  cycle_resolution_required: 'paymentReminders',
  cycle_complete: 'payoutUpdates',
  payout_eligible: 'payoutUpdates',
  payout_sent: 'payoutUpdates',
  payout_failed: 'payoutUpdates',
  payout_delayed_recovery: 'payoutUpdates',
  announcement: 'announcements',
  member_joined: 'groupActivity',
  group_invite: 'groupActivity',
  group_activated: 'groupActivity',
  reconciliation_update: 'payoutUpdates',
};

/**
 * Creates in-app notifications and fans out to push / email / SMS according to preferences.
 * Delivery failures are logged, never thrown: a failed push must not roll back a payment.
 *
 * @param {Array<string|ObjectId>} userIds
 * @param {{type:string,title:string,body:string,groupId?:any,data?:object,
 *          email?:boolean|{subject?:string,html?:string}, sms?:boolean|string}} n
 */
async function notify(userIds, n) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return [];
  const users = await User.find({ _id: { $in: ids }, status: 'active' });
  const bucket = CATEGORY[n.type];

  const docs = await Notification.insertMany(
    users.map((u) => ({ userId: u._id, type: n.type, title: n.title, body: n.body, groupId: n.groupId, data: n.data })),
  );

  await Promise.all(
    users.map(async (u) => {
      const prefs = u.notificationPreferences || {};
      if (bucket && prefs[bucket] === false) return;
      const tasks = [];
      if (prefs.push !== false && u.deviceTokens && u.deviceTokens.length) {
        tasks.push(
          sendPush(u.deviceTokens.map((d) => d.token), {
            title: n.title,
            body: n.body,
            data: { type: n.type, groupId: n.groupId, ...(n.data || {}) },
          }).then(async ({ invalidTokens }) => {
            if (invalidTokens.length) {
              await User.updateOne({ _id: u._id }, { $pull: { deviceTokens: { token: { $in: invalidTokens } } } });
            }
          }),
        );
      }
      if (n.email && prefs.email !== false && u.email) {
        const opts = typeof n.email === 'object' ? n.email : {};
        tasks.push(
          sendEmail({
            to: u.email,
            toName: u.name,
            subject: opts.subject || n.title,
            html: opts.html || layout(n.title, `<p>Hi ${escapeHtml(u.name.split(' ')[0])},</p><p>${escapeHtml(n.body)}</p>`),
          }),
        );
      }
      if (n.sms && prefs.sms !== false && u.phone) {
        tasks.push(sendSms(u.phone, typeof n.sms === 'string' ? n.sms : `${n.title}: ${n.body}`));
      }
      const results = await Promise.allSettled(tasks);
      for (const r of results) {
        if (r.status === 'rejected') console.error(`[notify] delivery failed for ${u._id}:`, r.reason && r.reason.message);
      }
    }),
  );
  return docs;
}

async function logActivity(groupId, actorId, eventType, summary, data) {
  return ActivityLog.create({ groupId, actorId: actorId || undefined, eventType, summary, data });
}

module.exports = { notify, logActivity, CATEGORY };
