/**
 * Session lifecycle rules of the browser session manager: ownership checks,
 * panel-owned vs thread-bound reaping, detach, and thread deletion.
 */

import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

const mocks = (() => ({ emitToUser: vi.fn() }))();

mock.module('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
mock.module('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: mocks.emitToUser } }));

import {
  browserSessionManager,
  type BrowserSession,
} from '../../services/browser-session-manager.js';
import { panelViewportSize } from '../../services/browser-session/panel-input.js';
import {
  buildBrowserSession,
  buildBrowserTab,
  fakeBrowserHost,
  stubChromeSession,
} from '../helpers/builders-agents.js';

const manager = browserSessionManager;
const sessions = manager['sessions'];
const MIN = 60_000;

function addSession(overrides: Partial<BrowserSession>) {
  const s = buildBrowserSession(overrides);
  sessions.set(s.sessionId, s);
  return s;
}

describe('BrowserSessionManager lifecycle', () => {
  let close: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessions.clear();
    mocks.emitToUser.mockClear();
    close?.mockRestore();
    close = vi.spyOn(manager, 'close').mockImplementation(async (id: string) => {
      sessions.delete(id);
    });
  });

  test('refuses sessions owned by another user', () => {
    addSession({ sessionId: 'panel-1', userId: 'u1' });
    expect(browserSessionManager.getOwned('u2', 'panel-1')).toBeNull();
    expect(browserSessionManager.getOwned('u1', 'panel-1')).not.toBeNull();
  });

  test('foreign input is dropped', async () => {
    const s = addSession({ sessionId: 'panel-1', userId: 'u1' });
    const dispatchMouseEvent = vi.fn();
    s.chromeSession = stubChromeSession({ dispatchMouseEvent });
    await browserSessionManager.dispatchInput('u2', 'panel-1', {
      sessionId: 'panel-1',
      kind: 'mouseDown',
      x: 1,
      y: 1,
    });
    expect(dispatchMouseEvent).not.toHaveBeenCalled();
  });

  test('panel-owned session closes when the heartbeat is lost', () => {
    addSession({ sessionId: 'panel-1', lastHeartbeat: 0 });
    browserSessionManager.reap(2 * MIN);
    expect(close).toHaveBeenCalledWith('panel-1', 'heartbeat');
  });

  test('thread-bound session only detaches when the heartbeat is lost', () => {
    const s = addSession({
      sessionId: 'thread:t1',
      threadId: 't1',
      owner: 'thread',
      lastHeartbeat: 0,
      lastAgentActivity: 0,
    });
    browserSessionManager.reap(2 * MIN);
    expect(close).not.toHaveBeenCalled();
    expect(s.panelAttached).toBe(false);
  });

  test('thread-bound session closes after the idle timeout', () => {
    addSession({
      sessionId: 'thread:t1',
      threadId: 't1',
      owner: 'thread',
      panelAttached: false,
      lastHeartbeat: 0,
      lastAgentActivity: 0,
    });
    browserSessionManager.reap(16 * MIN);
    expect(close).toHaveBeenCalledWith('thread:t1', 'idle');
  });

  test('recent agent activity keeps a thread session open', () => {
    addSession({
      sessionId: 'thread:t1',
      threadId: 't1',
      owner: 'thread',
      panelAttached: false,
      lastHeartbeat: 0,
      lastAgentActivity: 10 * MIN,
    });
    browserSessionManager.reap(16 * MIN);
    expect(close).not.toHaveBeenCalled();
  });

  test('detach keeps a thread session; close from a panel-owned session closes it', async () => {
    const s = addSession({ sessionId: 'thread:t1', threadId: 't1', owner: 'thread' });
    await browserSessionManager.closeFromClient('u1', 'thread:t1', 'detach');
    expect(close).not.toHaveBeenCalled();
    expect(s.panelAttached).toBe(false);

    addSession({ sessionId: 'panel-1' });
    await browserSessionManager.closeFromClient('u1', 'panel-1', 'detach');
    expect(close).toHaveBeenCalledWith('panel-1', 'user', undefined);
  });

  test('a client close passes its id on, for the closed event to echo', async () => {
    addSession({ sessionId: 'panel-2' });
    await browserSessionManager.closeFromClient('u1', 'panel-2', 'user', 'c-1');
    expect(close).toHaveBeenCalledWith('panel-2', 'user', 'c-1');
  });

  test('attach attempt for a missing session reports not_found and creates nothing', async () => {
    const result = await browserSessionManager.open('u1', 'thread:t9', '', { origin: 'panel' });
    expect(result).toBeNull();
    expect(mocks.emitToUser).toHaveBeenCalledWith('u1', {
      type: 'browser-session:closed',
      threadId: '',
      data: { sessionId: 'thread:t9', reason: 'not_found', threadId: 't9' },
    });
  });

  test('concurrent opens for the same id create one tab and one session', async () => {
    // Opening a tab awaits Chromium; make it slow so both opens race past the
    // `sessions` map miss before either registers. Without serialisation the
    // second open would create a second tab and orphan the first (issue #212).
    // openTab / startSession / emitReady are private, so they are replaced as own
    // properties (shadowing the prototype) and restored by deleting them.
    const openTab = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return {
        host: fakeBrowserHost({ port: 9300, closeTab: vi.fn(async () => {}) }),
        tab: buildBrowserTab(),
      };
    });
    manager['openTab'] = openTab;
    manager['startSession'] = vi.fn(async () => undefined);
    const navigate = vi.spyOn(manager, 'navigate').mockResolvedValue(undefined);
    manager['emitReady'] = vi.fn();

    const [a, b] = await Promise.all([
      browserSessionManager.open('u1', 'panel-9', 'https://example.com', { origin: 'panel' }),
      browserSessionManager.open('u1', 'panel-9', 'https://example.com', { origin: 'panel' }),
    ]);

    expect(openTab).toHaveBeenCalledTimes(1);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(sessions.size).toBe(1);

    Reflect.deleteProperty(manager, 'openTab');
    Reflect.deleteProperty(manager, 'startSession');
    navigate.mockRestore();
    Reflect.deleteProperty(manager, 'emitReady');
  });

  test('deleting a thread closes its session', async () => {
    addSession({ sessionId: 'thread:t1', threadId: 't1', owner: 'thread' });
    await browserSessionManager.closeForThread('u1', 't1');
    expect(close).toHaveBeenCalledWith('thread:t1', 'thread_deleted');
  });

  test('runExclusive serialises work on a session', async () => {
    const s = addSession({});
    const order: string[] = [];
    const slow = browserSessionManager.runExclusive(s, async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow');
    });
    const fast = browserSessionManager.runExclusive(s, async () => {
      order.push('fast');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow', 'fast']);
  });
});

describe('panelViewportSize', () => {
  test('accepts a phone size and a desktop size', () => {
    expect(panelViewportSize({ width: 390, height: 844 })).toEqual({ width: 390, height: 844 });
    expect(panelViewportSize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
  });

  test('refuses a missing, fractional or out-of-range size', () => {
    expect(panelViewportSize({})).toBeNull();
    expect(panelViewportSize({ width: 390.5, height: 844 })).toBeNull();
    expect(panelViewportSize({ width: 100, height: 844 })).toBeNull();
    expect(panelViewportSize({ width: 390, height: 5000 })).toBeNull();
  });
});
