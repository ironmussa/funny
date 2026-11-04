/**
 * Session lifecycle rules of the browser session manager: ownership checks,
 * panel-owned vs thread-bound reaping, detach, and thread deletion.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ emitToUser: vi.fn() }));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: mocks.emitToUser } }));

import { RefGenerations } from '../../services/browser-automation/snapshot-refs.js';
import { browserSessionManager } from '../../services/browser-session-manager.js';

const manager = browserSessionManager as any;
const MIN = 60_000;

function addSession(overrides: Record<string, unknown>) {
  const s = {
    sessionId: 'panel-1',
    userId: 'u1',
    threadId: null,
    owner: 'panel',
    profile: 'persistent',
    url: 'about:blank',
    host: { port: 9300, closeTab: vi.fn(async () => {}) },
    tab: { page: {}, targetId: 't', ephemeralContext: null },
    backgroundTabs: [],
    chromeSession: { disconnect: vi.fn(async () => {}) },
    viewport: { width: 1920, height: 1080 },
    lastHeartbeat: 0,
    panelAttached: true,
    lastAgentActivity: 0,
    controller: 'agent',
    refs: new RefGenerations(),
    pendingDialogReports: [],
    consoleErrors: [],
    queue: Promise.resolve(),
    ...overrides,
  };
  manager.sessions.set(s.sessionId, s);
  return s;
}

describe('BrowserSessionManager lifecycle', () => {
  let close: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    manager.sessions.clear();
    mocks.emitToUser.mockClear();
    close?.mockRestore();
    close = vi.spyOn(manager, 'close').mockImplementation(async (id: unknown) => {
      manager.sessions.delete(id);
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
    s.chromeSession = { dispatchMouseEvent } as any;
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
    expect(close).toHaveBeenCalledWith('panel-1', 'user');
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

  test('deleting a thread closes its session', async () => {
    addSession({ sessionId: 'thread:t1', threadId: 't1', owner: 'thread' });
    await browserSessionManager.closeForThread('u1', 't1');
    expect(close).toHaveBeenCalledWith('thread:t1', 'thread_deleted');
  });

  test('runExclusive serialises work on a session', async () => {
    const s = addSession({});
    const order: string[] = [];
    const slow = browserSessionManager.runExclusive(s as any, async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow');
    });
    const fast = browserSessionManager.runExclusive(s as any, async () => {
      order.push('fast');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow', 'fast']);
  });
});
