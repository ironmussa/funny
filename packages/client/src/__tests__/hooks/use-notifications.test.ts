import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const pushMocks = vi.hoisted(() => ({ hasPushSubscription: vi.fn(), testWebPush: vi.fn() }));
vi.mock('@/lib/web-push', () => pushMocks);

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: {
    getState: () => ({
      notificationsEnabled: true,
      notificationSoundEnabled: false,
    }),
  },
}));

import { isNotificationsSupported, showAgentNotification } from '@/hooks/use-notifications';

describe('use-notifications', () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.restoreAllMocks();
    pushMocks.hasPushSubscription.mockResolvedValue(false);
  });

  test('isNotificationsSupported reflects Notification API presence', async () => {
    expect(typeof isNotificationsSupported()).toBe('boolean');
  });

  test('showAgentNotification returns not-granted when permission is default', async () => {
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: Object.assign(function NotificationMock() {}, { permission: 'default' }),
    });

    const result = await showAgentNotification('funny', 'Agent finished', { force: true });

    expect(result).toEqual({ ok: false, reason: 'not-granted' });
  });

  test('showAgentNotification shows when granted and tab is hidden', async () => {
    const instances: Array<{ title: string; body: string; onclick: (() => void) | null }> = [];
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: class {
        static permission = 'granted';
        title: string;
        body: string;
        onclick: (() => void) | null = null;
        constructor(title: string, opts?: NotificationOptions) {
          this.title = title;
          this.body = opts?.body ?? '';
          instances.push(this);
        }
        close() {}
      },
    });

    const onClick = vi.fn();
    const result = await showAgentNotification('funny — feat', 'Agent finished', {
      tag: 'agent-result-t1',
      onClick,
      force: true,
    });

    expect(result).toEqual({ ok: true });
    expect(instances[0].title).toBe('funny — feat');
    instances[0].onclick?.();
    expect(onClick).toHaveBeenCalled();
  });

  test('showAgentNotification skips when tab is visible and not forced', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: Object.assign(function NotificationMock() {}, { permission: 'granted' }),
    });

    const result = await showAgentNotification('funny', 'Agent finished');

    expect(result).toEqual({ ok: false, reason: 'viewing-thread' });
  });
  test('uses the service worker on phones and includes the target thread URL', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn().mockResolvedValue({ active: {}, showNotification });
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    vi.stubGlobal(
      'Notification',
      Object.assign(
        vi.fn(() => {
          throw new Error('Illegal constructor');
        }),
        { permission: 'granted' },
      ),
    );
    expect(
      await showAgentNotification('Finished', 'Agent finished', {
        force: true,
        url: '/projects/p1/threads/t1',
      }),
    ).toEqual({ ok: true });
    expect(showNotification).toHaveBeenCalledWith(
      'Finished',
      expect.objectContaining({ data: { url: '/projects/p1/threads/t1' } }),
    );
  });

  test('reports service worker delivery failures', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: { register: vi.fn().mockRejectedValue(new Error('Registration failed')) },
    });
    vi.stubGlobal('Notification', { permission: 'granted' });
    expect(
      await showAgentNotification('Finished', 'Agent finished', { force: true }),
    ).toMatchObject({ ok: false, reason: 'error' });
  });
});

test('suppresses local delivery when the browser already subscribes to push', async () => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'granted' }));
  pushMocks.hasPushSubscription.mockResolvedValue(true);
  expect(await showAgentNotification('funny', 'Finished')).toEqual({
    ok: false,
    reason: 'push-enabled',
  });
  vi.unstubAllGlobals();
});
