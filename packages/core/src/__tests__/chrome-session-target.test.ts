/**
 * `ChromeSession` attaches to a specific page target when `targetId` is given,
 * so several sessions can stream different tabs of one browser.
 */

import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const connectArgs: unknown[] = [];
  const stubDomain = new Proxy(
    {},
    { get: () => vi.fn(() => Promise.resolve({ frameTree: { resources: [] } })) },
  );
  const client = new Proxy(
    { on: vi.fn() },
    { get: (target, key) => (key in target ? (target as any)[key] : stubDomain) },
  );
  const CDP = Object.assign(
    vi.fn((opts: unknown) => {
      connectArgs.push(opts);
      return Promise.resolve(client);
    }),
    {
      List: vi.fn(() =>
        Promise.resolve([
          { id: 'tab-a', type: 'page', webSocketDebuggerUrl: 'ws://a' },
          { id: 'tab-b', type: 'page', webSocketDebuggerUrl: 'ws://b' },
        ]),
      ),
    },
  );
  return { CDP, connectArgs };
});

vi.mock('chrome-remote-interface', () => ({ default: mocks.CDP }));

import { ChromeSession } from '../chrome/chrome-session.js';

describe('ChromeSession targetId', () => {
  test('attaches to the requested target', async () => {
    mocks.connectArgs.length = 0;
    await new ChromeSession({ targetId: 'tab-b' }).connect();
    expect(mocks.connectArgs).toEqual([{ target: 'ws://b' }]);
  });

  test('falls back to the first page without targetId', async () => {
    mocks.connectArgs.length = 0;
    await new ChromeSession().connect();
    expect(mocks.connectArgs).toEqual([{ target: 'ws://a' }]);
  });

  test('fails when the requested target is gone', async () => {
    await expect(new ChromeSession({ targetId: 'missing' }).connect()).rejects.toThrow(
      'Target missing not found',
    );
  });
});
