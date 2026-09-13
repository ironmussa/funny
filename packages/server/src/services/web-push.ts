import { and, eq } from 'drizzle-orm';
import webpush from 'web-push';
import { z } from 'zod';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import { pushSubscriptions, threads } from '../db/schema.js';

// Restrict outbound requests to browser push providers; never accept arbitrary URLs.
export function isPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === 'fcm.googleapis.com' ||
        url.hostname === 'updates.push.services.mozilla.com' ||
        url.hostname.endsWith('.push.services.mozilla.com') ||
        url.hostname === 'web.push.apple.com' ||
        url.hostname.endsWith('.notify.windows.com'))
    );
  } catch {
    return false;
  }
}

export const subscriptionSchema = z.object({
  endpoint: z.string().max(4096).refine(isPushEndpoint),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
});

export function pushConfig() {
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY;
  const subject = process.env.WEB_PUSH_SUBJECT;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

export async function saveSubscription(userId: string, input: z.infer<typeof subscriptionSchema>) {
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
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410)
            await removeSubscription(userId, subscription.endpoint);
        }
      }),
    );
  }
  return sent;
}

export async function pushAgentResult(userId: string, event: Record<string, unknown>) {
  if (!pushConfig() || event.type !== 'agent:result' || typeof event.threadId !== 'string') return;
  const data = event.data as { status?: string } | undefined;
  if (!['completed', 'failed', 'error'].includes(data?.status ?? '')) return;
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
