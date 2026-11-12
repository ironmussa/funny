import type { PushSubscriptionBody } from '@funny/shared/contracts/push';
import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import { trpc, trpcCall } from './api/_trpc';
import { getNotificationWorker } from './notification-worker';

/** Push calls throw on failure: the settings UI reports the message. */
async function unwrapPush<T>(call: ResultAsync<T, DomainError>): Promise<T> {
  const result = await call;
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
}

export function supportsWebPush(): boolean {
  return typeof window !== 'undefined' && 'PushManager' in window && 'serviceWorker' in navigator;
}

export async function hasPushSubscription(): Promise<boolean> {
  if (!supportsWebPush()) return false;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return !!(await registration?.pushManager.getSubscription());
}

export async function enableWebPush(): Promise<void> {
  if (!supportsWebPush()) throw new Error('Web Push is unavailable in this browser');
  const { publicKey } = await unwrapPush(trpcCall(() => trpc.push.config.query()));
  if (!publicKey) throw new Error('Web Push is not configured on the server');
  const registration = await getNotificationWorker();
  let subscription = await registration.pushManager.getSubscription();
  const existing = subscription;
  if (!subscription) {
    const encoded = publicKey.replace(/-/g, '+').replace(/_/g, '/');
    const key = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
  }
  try {
    await unwrapPush(
      trpcCall(() => trpc.push.subscribe.mutate(subscription.toJSON() as PushSubscriptionBody)),
    );
  } catch (error) {
    if (!existing) await subscription.unsubscribe();
    throw error;
  }
}

export async function disableWebPush(): Promise<void> {
  if (!supportsWebPush()) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await unwrapPush(
    trpcCall(() => trpc.push.unsubscribe.mutate({ endpoint: subscription.endpoint })),
  );
  await subscription.unsubscribe();
}

export async function testWebPush(): Promise<void> {
  await enableWebPush();
  const registration = await getNotificationWorker();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) throw new Error('Push subscription unavailable');
  await unwrapPush(trpcCall(() => trpc.push.test.mutate({ endpoint: subscription.endpoint })));
}
