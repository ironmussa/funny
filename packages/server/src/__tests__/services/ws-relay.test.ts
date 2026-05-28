/**
 * Tests for ws-relay.ts — the in-memory runner index that backs the
 * `runner:status` readiness channel.
 *
 * Regression context: the original "black-screen-on-refresh" terminal bug
 * was rooted in clients dispatching `pty:list` before the runner had
 * reconnected. The fix introduced a per-user runner index so the server
 * can answer `userHasConnectedRunner(userId)` in O(1) and emit a
 * deterministic `runner:status` event. These tests pin that contract.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

import {
  addRunnerClient,
  removeRunnerClient,
  isRunnerConnected,
  getRunnerSocketId,
  userHasConnectedRunner,
  setIO,
  relayToUser,
  broadcast,
  sendToRunner,
  forwardBrowserMessageToRunner,
  getAnyConnectedRunnerId,
  getConnectedBrowserUserIds,
  getRelayStats,
} from '../../services/ws-relay.js';

/**
 * Reset the in-memory maps between tests by removing any runners that
 * leaked from previous cases. We don't export the maps directly (and
 * shouldn't), so we rely on the module-level state being a clean slate
 * once we remove every runnerId we registered in the test.
 */
const TEST_RUNNERS = ['r1', 'r2', 'r3', 'r4'];

beforeEach(() => {
  for (const runnerId of TEST_RUNNERS) {
    removeRunnerClient(runnerId);
  }
});

describe('ws-relay runner index', () => {
  test('addRunnerClient registers the runner and its socket', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    expect(isRunnerConnected('r1')).toBe(true);
    expect(getRunnerSocketId('r1')).toBe('sock-1');
  });

  test('addRunnerClient returns the previously-registered socketId', () => {
    expect(addRunnerClient('r1', 'sock-1', 'user-A')).toBeNull();
    expect(addRunnerClient('r1', 'sock-2', 'user-A')).toBe('sock-1');
    expect(getRunnerSocketId('r1')).toBe('sock-2');
  });

  test('removeRunnerClient clears the socket entry', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    removeRunnerClient('r1');
    expect(isRunnerConnected('r1')).toBe(false);
    expect(getRunnerSocketId('r1')).toBeNull();
  });

  test('removeRunnerClient with stale socketId is a no-op', () => {
    // Reproduces the reconnect race: the OLD socket's disconnect arrives
    // AFTER a NEW socket has already taken the map slot. Without the
    // socketId guard, the stale disconnect would unregister the live runner.
    addRunnerClient('r1', 'sock-1', 'user-A');
    addRunnerClient('r1', 'sock-2', 'user-A');
    removeRunnerClient('r1', 'sock-1'); // stale
    expect(isRunnerConnected('r1')).toBe(true);
    expect(getRunnerSocketId('r1')).toBe('sock-2');
  });

  test('removeRunnerClient with matching socketId clears the entry', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    removeRunnerClient('r1', 'sock-1');
    expect(isRunnerConnected('r1')).toBe(false);
  });
});

describe('ws-relay userHasConnectedRunner (readiness signal)', () => {
  test('returns false for unknown user', () => {
    expect(userHasConnectedRunner('user-A')).toBe(false);
  });

  test('returns true while a runner is registered for the user', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    expect(userHasConnectedRunner('user-A')).toBe(true);
  });

  test('returns false after the only runner is removed', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    removeRunnerClient('r1');
    expect(userHasConnectedRunner('user-A')).toBe(false);
  });

  test('stays true when one of multiple runners disconnects', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    addRunnerClient('r2', 'sock-2', 'user-A');
    removeRunnerClient('r1');
    expect(userHasConnectedRunner('user-A')).toBe(true);
    removeRunnerClient('r2');
    expect(userHasConnectedRunner('user-A')).toBe(false);
  });

  test('isolates users from each other', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    addRunnerClient('r2', 'sock-2', 'user-B');
    expect(userHasConnectedRunner('user-A')).toBe(true);
    expect(userHasConnectedRunner('user-B')).toBe(true);
    removeRunnerClient('r1');
    expect(userHasConnectedRunner('user-A')).toBe(false);
    expect(userHasConnectedRunner('user-B')).toBe(true);
  });

  test('ignores runners without an owning userId (legacy/null)', () => {
    addRunnerClient('r1', 'sock-1', null);
    expect(userHasConnectedRunner('user-A')).toBe(false);
  });

  test('re-registering with a new userId migrates the index', () => {
    addRunnerClient('r1', 'sock-1', 'user-A');
    expect(userHasConnectedRunner('user-A')).toBe(true);
    // A reconnect under a different owner shouldn't leave stale entries
    // pointing to user-A — the readiness signal would lie otherwise.
    addRunnerClient('r1', 'sock-2', 'user-B');
    expect(userHasConnectedRunner('user-A')).toBe(false);
    expect(userHasConnectedRunner('user-B')).toBe(true);
  });

  test('stale-socket disconnect does not flip readiness off', () => {
    // The bug we want to prevent: a delayed disconnect from the OLD
    // socket clears the userId index even though a NEW socket is live.
    // Without proper guarding, the user's browser would briefly see
    // `runner:status: offline` and the terminal panel would fall back
    // to "awaiting runner" — exactly the kind of UX regression that
    // re-introduces the black-screen behavior we just fixed.
    addRunnerClient('r1', 'sock-1', 'user-A');
    addRunnerClient('r1', 'sock-2', 'user-A');
    removeRunnerClient('r1', 'sock-1'); // stale
    expect(userHasConnectedRunner('user-A')).toBe(true);
  });
});

describe('ws-relay Socket.IO delivery', () => {
  const relayCalls: Array<{ room: string; event: string; payload: unknown }> = [];
  const runnerCalls: Array<{ socketId: string; event: string; payload: unknown }> = [];

  function installMockIo() {
    relayCalls.length = 0;
    runnerCalls.length = 0;

    const browserNs = {
      sockets: { size: 3 },
      adapter: {
        rooms: new Map([
          ['user:alice', new Set(['sock-a'])],
          ['user:bob', new Set(['sock-b'])],
          ['runner:r1', new Set(['sock-r1'])],
        ]),
      },
      emit: (event: string, payload: unknown) => {
        relayCalls.push({ room: '*', event, payload });
      },
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => {
          relayCalls.push({ room, event, payload });
        },
      }),
    };

    const runnerNs = {
      to: (socketId: string) => ({
        emit: (event: string, payload: unknown) => {
          runnerCalls.push({ socketId, event, payload });
        },
      }),
    };

    setIO({
      of: (name: string) => (name === '/runner' ? runnerNs : browserNs),
    } as any);
  }

  beforeEach(() => {
    for (const runnerId of TEST_RUNNERS) removeRunnerClient(runnerId);
    installMockIo();
    addRunnerClient('r1', 'sock-r1', 'user-A');
  });

  test('relayToUser emits to the user room', () => {
    relayToUser('alice', { type: 'agent:status', threadId: 't1' });
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]?.room).toBe('user:alice');
    expect(relayCalls[0]?.event).toBe('agent:status');
  });

  test('broadcast emits to all browser clients', () => {
    broadcast({ type: 'system:pulse' });
    expect(relayCalls[0]?.room).toBe('*');
    expect(relayCalls[0]?.event).toBe('system:pulse');
  });

  test('sendToRunner targets the registered socketId', () => {
    const ok = sendToRunner('r1', { type: 'central:ping' });
    expect(ok).toBe(true);
    expect(runnerCalls[0]?.socketId).toBe('sock-r1');
    expect(runnerCalls[0]?.event).toBe('central:ping');
  });

  test('sendToRunner returns false when runner is not connected', () => {
    removeRunnerClient('r1');
    expect(sendToRunner('r1', { type: 'central:ping' })).toBe(false);
  });

  test('forwardBrowserMessageToRunner wraps browser payload', () => {
    const ok = forwardBrowserMessageToRunner('r1', 'user-A', 'org-1', { cmd: 'pty:list' });
    expect(ok).toBe(true);
    expect(runnerCalls[0]?.payload).toEqual({
      type: 'central:browser_ws',
      userId: 'user-A',
      organizationId: 'org-1',
      data: { cmd: 'pty:list' },
    });
  });

  test('getAnyConnectedRunnerId returns a registered runner', () => {
    expect(getAnyConnectedRunnerId()).toBe('r1');
  });

  test('getConnectedBrowserUserIds lists user:* rooms', () => {
    expect(getConnectedBrowserUserIds().sort()).toEqual(['alice', 'bob']);
  });

  test('getRelayStats reports runner and browser counts', () => {
    addRunnerClient('r2', 'sock-r2', 'user-B');
    const stats = getRelayStats();
    expect(stats.runners).toBe(2);
    expect(stats.browserClients).toBe(3);
    expect(stats.browserUsers).toBe(2);
  });
});
