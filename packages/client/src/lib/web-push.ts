import { request } from './api/_core';
import { getNotificationWorker } from './notification-worker';

async function pushRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const result = await request<T>(`/push/${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
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
  const { publicKey } = await pushRequest<{ publicKey: string | null }>('config');
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
    await pushRequest('subscription', 'PUT', subscription.toJSON());
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
  await pushRequest('subscription', 'DELETE', { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

export async function testWebPush(): Promise<void> {
  await enableWebPush();
  const registration = await getNotificationWorker();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) throw new Error('Push subscription unavailable');
  await pushRequest('test', 'POST', { endpoint: subscription.endpoint });
}
