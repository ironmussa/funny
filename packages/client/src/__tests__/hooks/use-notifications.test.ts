import { beforeEach, describe, expect, test, vi } from 'vitest';

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
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('isNotificationsSupported reflects Notification API presence', () => {
    expect(typeof isNotificationsSupported()).toBe('boolean');
  });

  test('showAgentNotification returns not-granted when permission is default', () => {
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: class {
        static permission = 'default';
        constructor(_title: string, _opts?: NotificationOptions) {}
      },
    });

    const result = showAgentNotification('funny', 'Agent finished', { force: true });

    expect(result).toEqual({ ok: false, reason: 'not-granted' });
  });

  test('showAgentNotification shows when granted and tab is hidden', () => {
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
    const result = showAgentNotification('funny — feat', 'Agent finished', {
      tag: 'agent-result-t1',
      onClick,
      force: true,
    });

    expect(result).toEqual({ ok: true });
    expect(instances[0].title).toBe('funny — feat');
    instances[0].onclick?.();
    expect(onClick).toHaveBeenCalled();
  });

  test('showAgentNotification skips when tab is visible and not forced', () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: class {
        static permission = 'granted';
        constructor(_title: string, _opts?: NotificationOptions) {}
      },
    });

    const result = showAgentNotification('funny', 'Agent finished');

    expect(result).toEqual({ ok: false, reason: 'viewing-thread' });
  });
});
