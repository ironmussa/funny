/**
 * Re-attaching a tab's panel CDP client must always release the client it
 * replaces, even when the new connection fails — otherwise a failed popup
 * switch / tab restore leaks the previous CDP WebSocket to Chromium.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  setViewport: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));

vi.mock('@funny/core/chrome', () => ({
  ChromeSession: class {
    on = vi.fn();
    connect = mocks.connect;
    setViewport = mocks.setViewport;
    disconnect = mocks.disconnect;
  },
}));

import { browserSessionManager } from '../../services/browser-session-manager.js';

const manager = browserSessionManager as any;

function sessionWith(previous: { disconnect: ReturnType<typeof vi.fn> } | null) {
  return {
    sessionId: 'panel-1',
    userId: 'u1',
    host: { port: 9300 },
    viewport: { width: 1920, height: 1080 },
    chromeSession: previous,
    recorder: null,
  };
}

describe('attachChromeSession releases the replaced CDP client', () => {
  beforeEach(() => {
    mocks.connect.mockReset();
    mocks.setViewport.mockClear();
    mocks.disconnect.mockClear();
  });

  test('disconnects the previous client when the new connect throws', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('connect failed'));
    const previous = { disconnect: vi.fn(async () => {}) };
    const s = sessionWith(previous);

    await expect(manager.attachChromeSession(s, 'target-1')).rejects.toThrow('connect failed');

    expect(previous.disconnect).toHaveBeenCalledTimes(1);
    // The new (failed) client has replaced the previous one on the session.
    expect(s.chromeSession).not.toBe(previous);
  });

  test('disconnects the previous client after a successful re-attach', async () => {
    mocks.connect.mockResolvedValueOnce(undefined);
    const previous = { disconnect: vi.fn(async () => {}) };
    const s = sessionWith(previous);

    await manager.attachChromeSession(s, 'target-2');

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(previous.disconnect).toHaveBeenCalledTimes(1);
    expect(s.chromeSession).not.toBe(previous);
  });

  test('tolerates the absence of a previous client', async () => {
    mocks.connect.mockResolvedValueOnce(undefined);
    const s = sessionWith(null);

    await expect(manager.attachChromeSession(s, 'target-3')).resolves.toBeUndefined();
  });
});
