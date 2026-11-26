import { isPushEndpoint, type PushSubscriptionBody } from '@funny/shared/contracts/push';
import { and, eq } from 'drizzle-orm';
import webpush from 'web-push';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import { pushSubscriptions, threads } from '../db/schema.js';
import { isString } from '../lib/value-guards.js';
import type { BrowserEvent } from './runner-ports.js';

// The endpoint check is shared with the tRPC inputs (`@funny/shared/contracts/push`).
export { isPushEndpoint };

export function pushConfig() {
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY;
  const subject = process.env.WEB_PUSH_SUBJECT;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

export async function saveSubscription(userId: string, input: PushSubscriptionBody) {
  await dbRun(
    db
      .insert(pushSubscriptions)
      .values({ userId, endpoint: input.endpoint, ...input.keys })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId, ...input.keys } }),
  );
}

export async function removeSubscription(userId: string, endpoint: string) {
  await dbRun(
    db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint))),
  );
}

export async function sendPush(
  userId: string,
  payload: { title: string; body: string; url: string; tag: string },
  endpoint?: string,
) {
  const vapidDetails = pushConfig();
  if (!vapidDetails) return 0;
  const subscriptions = await dbAll<typeof pushSubscriptions.$inferSelect>(
    db
      .select()
      .from(pushSubscriptions)
      .where(
        endpoint
          ? and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint))
          : eq(pushSubscriptions.userId, userId),
      ),
  );
  let sent = 0;
  // Bound concurrent outbound requests, including accounts with multiple devices.
  for (let i = 0; i < subscriptions.length; i += 5) {
    await Promise.all(
      subscriptions.slice(i, i + 5).map(async (subscription) => {
        if (!isPushEndpoint(subscription.endpoint)) return;
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            JSON.stringify(payload),
            { vapidDetails, TTL: 3600, timeout: 10000 },
          );
          sent++;
        } catch (error) {
          // SAFETY: webpush.sendNotification rejects only with an Error object (a WebPushError
          // carries statusCode), so reading the field cannot throw.
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410)
            await removeSubscription(userId, subscription.endpoint);
        }
      }),
    );
  }
  return sent;
}

export async function pushAgentResult(userId: string, event: BrowserEvent) {
  if (!pushConfig() || event.type !== 'agent:result' || !isString(event.threadId)) return;
  // SAFETY: data is read only as `data?.status` and compared by includes() with string
  // literals below, which accepts any value.
  const data = event.data as { status?: string; continuesAutomatically?: unknown } | undefined;
  if (!['completed', 'failed', 'error'].includes(data?.status ?? '')) return;
  // A queued follow-up or a background job starts the agent again: not over yet.
  if (data?.continuesAutomatically === true) return;
  const thread = await dbGet<typeof threads.$inferSelect>(
    db
      .select()
      .from(threads)
      .where(and(eq(threads.id, event.threadId), eq(threads.userId, userId))),
  );
  if (!thread || (!thread.isScratch && !thread.projectId)) return;
  const url = thread.isScratch
    ? `/scratch/${encodeURIComponent(thread.id)}`
    : `/projects/${encodeURIComponent(thread.projectId!)}/threads/${encodeURIComponent(thread.id)}`;
  await sendPush(userId, {
    title: 'funny',
    body: data?.status === 'completed' ? 'Agent finished' : 'Agent failed',
    url,
    tag: `agent-result-${thread.id}`,
  });
}
