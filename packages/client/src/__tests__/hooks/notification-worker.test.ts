import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, test, vi } from 'vitest';

const source = readFileSync('public/notification-sw.js', 'utf8');

function setup(url: string) {
  const handlers = new Map<string, (event: any) => void>();
  const client = {
    url: 'https://funny.test/',
    navigate: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
  };
  const clients = { matchAll: vi.fn().mockResolvedValue([client]), openWindow: vi.fn() };
  runInNewContext(source, {
    URL,
    self: {
      location: { origin: 'https://funny.test' },
      clients,
      addEventListener: (name: string, handler: (event: any) => void) =>
        handlers.set(name, handler),
    },
  });
  const event = { notification: { close: vi.fn(), data: { url } }, waitUntil: vi.fn() };
  handlers.get('notificationclick')!(event);
  return { client, clients, event };
}

describe('notification click', () => {
  test('focuses an existing window and opens the completed thread', async () => {
    const { client, event } = setup('/acme/projects/p1/threads/t1');
    await event.waitUntil.mock.calls[0][0];
    expect(event.notification.close).toHaveBeenCalled();
    expect(client.navigate).toHaveBeenCalledWith('https://funny.test/acme/projects/p1/threads/t1');
    expect(client.focus).toHaveBeenCalled();
  });

  test('rejects destinations outside this application', () => {
    const { clients, event } = setup('https://another.test/');
    expect(clients.matchAll).not.toHaveBeenCalled();
    expect(event.waitUntil).not.toHaveBeenCalled();
  });
});

describe('push delivery', () => {
  test.each([true, false])(
    'displays a system notification without an open page (valid payload: %s)',
    async (valid) => {
      const handlers = new Map<string, (event: any) => void>();
      const showNotification = vi.fn().mockResolvedValue(undefined);
      runInNewContext(source, {
        self: {
          registration: { showNotification },
          addEventListener: (name: string, handler: (event: any) => void) =>
            handlers.set(name, handler),
        },
      });
      const event = {
        data: {
          json: () => {
            if (!valid) throw new Error('bad JSON');
            return { title: 'Finished', body: 'Done', url: '/scratch/t1', tag: 't1' };
          },
        },
        waitUntil: vi.fn(),
      };
      handlers.get('push')!(event);
      await event.waitUntil.mock.calls[0][0];
      expect(showNotification).toHaveBeenCalledWith(
        valid ? 'Finished' : 'funny',
        expect.objectContaining({ data: { url: valid ? '/scratch/t1' : '/' } }),
      );
    },
  );
});
