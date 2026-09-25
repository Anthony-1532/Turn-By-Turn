import type { Types } from 'mongoose';
import { User, Notification, ActivityLog, type NotificationPreferenceKey } from '../models';
import { sendPush } from './push';
import { sendEmail, layout, escapeHtml } from './zeptomail';
import { sendSms } from './squadco';

type Id = Types.ObjectId | string;

export type NotificationType =
  | 'cycle_opened'
  | 'payment_received'
  | 'partial_payment_received'
  | 'payment_reminder'
  | 'cycle_overdue'
  | 'cycle_resolution_required'
  | 'cycle_complete'
  | 'payout_eligible'
  | 'payout_sent'
  | 'payout_failed'
  | 'payout_delayed_recovery'
  | 'announcement'
  | 'member_joined'
  | 'group_invite'
  | 'group_activated'
  | 'reconciliation_update';

/**
 * Preference bucket each notification type belongs to; users can mute a bucket in
 * Profile → Notifications. Types without a bucket are always delivered.
 */
export const CATEGORY: Partial<Record<NotificationType, NotificationPreferenceKey>> = {
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

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body: string;
  groupId?: Id;
  data?: Record<string, unknown>;
  email?: boolean | { subject?: string; html?: string };
  sms?: boolean | string;
}

/**
 * Creates in-app notifications and fans out to push / email / SMS according to preferences.
 * Delivery failures are logged, never thrown: a failed push must not roll back a payment.
 */
export async function notify(userIds: Array<Id | null | undefined>, n: NotifyInput): Promise<void> {
  const ids = [...new Set(userIds.filter((x): x is Id => Boolean(x)).map(String))];
  if (!ids.length) return;
  const users = await User.find({ _id: { $in: ids }, status: 'active' });
  const bucket = CATEGORY[n.type];

  await Notification.insertMany(
    users.map((u) => ({ userId: u._id, type: n.type, title: n.title, body: n.body, groupId: n.groupId, data: n.data })),
  );

  await Promise.all(
    users.map(async (u) => {
      const prefs = u.notificationPreferences;
      if (bucket && prefs?.[bucket] === false) return;
      const tasks: Array<Promise<unknown>> = [];
      if (prefs?.push !== false && u.deviceTokens.length) {
        tasks.push(
          sendPush(
            u.deviceTokens.map((d) => d.token),
            { title: n.title, body: n.body, data: { type: n.type, groupId: n.groupId, ...n.data } },
          ).then(async ({ invalidTokens }) => {
            if (invalidTokens.length) {
              await User.updateOne({ _id: u._id }, { $pull: { deviceTokens: { token: { $in: invalidTokens } } } });
            }
          }),
        );
      }
      if (n.email && prefs?.email !== false && u.email) {
        const opts = typeof n.email === 'object' ? n.email : {};
        tasks.push(
          sendEmail({
            to: u.email,
            toName: u.name,
            subject: opts.subject ?? n.title,
            html: opts.html ?? layout(n.title, `<p>Hi ${escapeHtml(u.name.split(' ')[0])},</p><p>${escapeHtml(n.body)}</p>`),
          }),
        );
      }
      if (n.sms && prefs?.sms !== false && u.phone) {
        tasks.push(sendSms(u.phone, typeof n.sms === 'string' ? n.sms : `${n.title}: ${n.body}`));
      }
      const results = await Promise.allSettled(tasks);
      for (const r of results) {
        if (r.status === 'rejected') console.error(`[notify] delivery failed for ${u._id}:`, (r.reason as Error)?.message);
      }
    }),
  );
}

export async function logActivity(
  groupId: Id,
  actorId: Id | null | undefined,
  eventType: string,
  summary: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await ActivityLog.create({ groupId, actorId: actorId ?? undefined, eventType, summary, data });
}
