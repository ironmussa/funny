import { errAsync, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn(), getWorker: vi.fn() }));
vi.mock('@/lib/api/_core', () => ({ request: mocks.request }));
vi.mock('@/lib/notification-worker', () => ({ getNotificationWorker: mocks.getWorker }));
import { disableWebPush, enableWebPush, hasPushSubscription, testWebPush } from '@/lib/web-push';

const subscription = {
  endpoint: 'https://fcm.googleapis.com/device',
  toJSON: () => ({
    endpoint: 'https://fcm.googleapis.com/device',
    keys: { auth: 'auth', p256dh: 'key' },
  }),
  unsubscribe: vi.fn(),
};
const manager = { getSubscription: vi.fn(), subscribe: vi.fn() };
const registration = { pushManager: manager };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('PushManager', function () {});
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistration: vi.fn().mockResolvedValue(registration) },
  });
  manager.subscribe.mockResolvedValue(subscription);
  manager.getSubscription.mockResolvedValue(null);
  mocks.getWorker.mockResolvedValue(registration);
  mocks.request.mockImplementation((path: string) =>
    trpcOk(path.startsWith('/trpc/push.config') ? { publicKey: 'AQID' } : { ok: true }),
  );
});
afterEach(() => vi.unstubAllGlobals());

// The push calls go through tRPC (`/trpc/push.*`), whose link sends them with `request`.
const trpcOk = (data: unknown) => okAsync({ result: { data } });
const failed = (message: string) => errAsync({ type: 'INTERNAL', message });
const mutation = (procedure: string, input: unknown) => [
  `/trpc/push.${procedure}`,
  expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
];
describe('browser push subscription lifecycle', () => {
  test('creates and saves a subscription with the application server key', async () => {
    await enableWebPush();
    expect(manager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
    expect(mocks.request).toHaveBeenLastCalledWith(...mutation('subscribe', subscription.toJSON()));
  });
  test('rolls back a new browser subscription if server registration fails', async () => {
    mocks.request
      .mockReturnValueOnce(trpcOk({ publicKey: 'AQID' }))
      .mockReturnValueOnce(failed('Offline'));
    await expect(enableWebPush()).rejects.toThrow('Offline');
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });
  test('does not subscribe if VAPID is unconfigured', async () => {
    mocks.request.mockReturnValue(trpcOk({ publicKey: null }));
    await expect(enableWebPush()).rejects.toThrow('not configured');
    expect(manager.subscribe).not.toHaveBeenCalled();
  });
  test('keeps subscription on failed removal so disabling can be retried', async () => {
    manager.getSubscription.mockResolvedValue(subscription);
    mocks.request.mockReturnValue(failed('Offline'));
    await expect(disableWebPush()).rejects.toThrow('Offline');
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });
  test('removes the subscription from the server and browser', async () => {
    manager.getSubscription.mockResolvedValue(subscription);
    await disableWebPush();
    expect(mocks.request).toHaveBeenCalledWith(
      ...mutation('unsubscribe', { endpoint: subscription.endpoint }),
    );
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });
  test('reuses the subscription and tests via the server', async () => {
    manager.getSubscription.mockResolvedValue(subscription);
    expect(await hasPushSubscription()).toBe(true);
    await testWebPush();
    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenLastCalledWith(
      ...mutation('test', { endpoint: subscription.endpoint }),
    );
  });
});
