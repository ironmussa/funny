import { describe, test, expect, beforeEach, afterEach, vi } from 'bun:test';

import { advanceTimersByTimeAsync, mocked } from '@funny/test-kit';

// ── Mock the manager's dependencies ──────────────────────────────
// Shared mock state lives in vi.hoisted so the (hoisted) vi.mock factories
// can reference it. `rows` is an in-memory fake of IWatcherRepository.
const { rows, fakeWatchers, emitToUser } = (() => {
  const rows = new Map<string, any>();
  const LIVE = new Set(['pending', 'fired']);
  const fakeWatchers = {
    async insertWatcher(row: any) {
      rows.set(row.id, { ...row });
    },
    async getWatcher(id: string) {
      return rows.get(id);
    },
    async getLiveWatcherByThreadKey(threadId: string, key: string) {
      return [...rows.values()].find(
        (w) => w.threadId === threadId && w.key === key && LIVE.has(w.status),
      );
    },
    // Like the repository: a status is written only from a status the watcher
    // machine allows, and the result says whether it was.
    async updateWatcher(id: string, patch: any, expect?: { expectedNextWakeAt?: number }) {
      const cur = rows.get(id);
      if (!cur) return false;
      if (
        expect?.expectedNextWakeAt !== undefined &&
        cur.nextWakeAt !== expect.expectedNextWakeAt
      ) {
        return false;
      }
      const from: Record<string, string[]> = {
        pending: ['pending', 'fired'],
        fired: ['pending'],
        expired: ['pending'],
        done: ['fired'],
        cancelled: ['pending', 'fired'],
      };
      if (patch.status !== undefined && !from[patch.status]?.includes(cur.status)) return false;
      rows.set(id, { ...cur, ...patch });
      return true;
    },
    async listPendingWatchers() {
      return [...rows.values()].filter((w) => w.status === 'pending');
    },
    async listDueWatchers(now: number) {
      return [...rows.values()].filter((w) => w.status === 'pending' && w.nextWakeAt <= now);
    },
    async listWatchersByUser(userId: string) {
      return [...rows.values()].filter((w) => w.userId === userId);
    },
    async deleteWatchersByThread(threadId: string) {
      for (const [id, w] of rows) if (w.threadId === threadId) rows.delete(id);
    },
  };
  return { rows, fakeWatchers, emitToUser: vi.fn() };
})();

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ watchers: fakeWatchers }),
}));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser } }));
vi.mock('../../services/agent-runner-control.js', () => ({ isAgentRunning: () => false }));
vi.mock('../../services/thread-service/messaging.js', () => ({ sendMessage: vi.fn() }));
vi.mock('../../services/shutdown-manager.js', () => ({
  shutdownManager: { register: vi.fn() },
  ShutdownPhase: { SERVICES: 'services' },
}));

import {
  createOrReschedule,
  startAgentWatchers,
  stopAgentWatchers,
} from '../../services/agent-watcher-manager.js';

beforeEach(() => {
  stopAgentWatchers();
  rows.clear();
  emitToUser.mockClear();
});

afterEach(() => {
  stopAgentWatchers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createOrReschedule — idempotent by (threadId, key)', () => {
  test('first call for a new key creates exactly one watcher', async () => {
    const w = await createOrReschedule({
      threadId: 't1',
      userId: 'user-1',
      key: 'build',
      label: 'build',
      delayMs: 120_000,
    });

    expect(w.status).toBe('pending');
    expect(w.wakeCount).toBe(0);
    expect(rows.size).toBe(1);
    // watcher:created emitted to the owning user
    expect(emitToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'watcher:created' }),
    );
  });

  test('second call for the same (threadId, key) re-arms — no duplicate row', async () => {
    const first = await createOrReschedule({
      threadId: 't1',
      userId: 'user-1',
      key: 'build',
      label: 'build',
      delayMs: 120_000,
    });
    // Simulate the watcher having fired before the reschedule.
    await fakeWatchers.updateWatcher(first.id, { status: 'fired', wakeCount: 1 });

    const second = await createOrReschedule({
      threadId: 't1',
      userId: 'user-1',
      key: 'build',
      label: 'build',
      delayMs: 300_000,
    });

    expect(second.id).toBe(first.id); // same identity
    expect(rows.size).toBe(1); // no duplicate
    expect(second.status).toBe('pending'); // re-armed
    expect(rows.get(first.id).wakeCount).toBe(1); // wakeCount preserved
    expect(emitToUser).toHaveBeenLastCalledWith(
      'user-1',
      expect.objectContaining({ type: 'watcher:rescheduled' }),
    );
  });

  test('a watcher cancelled in the meantime is not re-armed: a new one is created', async () => {
    const first = await createOrReschedule({
      threadId: 't1',
      userId: 'user-1',
      key: 'build',
      label: 'build',
      delayMs: 120_000,
    });
    // The cancel lands after the manager read the live row.
    const readLive = fakeWatchers.getLiveWatcherByThreadKey;
    fakeWatchers.getLiveWatcherByThreadKey = async (threadId: string, key: string) => {
      const live = await readLive(threadId, key);
      rows.set(first.id, { ...rows.get(first.id), status: 'cancelled' });
      return live;
    };
    try {
      const second = await createOrReschedule({
        threadId: 't1',
        userId: 'user-1',
        key: 'build',
        label: 'build',
        delayMs: 300_000,
      });
      expect(second.id).not.toBe(first.id);
      expect(rows.get(first.id).status).toBe('cancelled');
      expect(rows.get(second.id).status).toBe('pending');
    } finally {
      fakeWatchers.getLiveWatcherByThreadKey = readLive;
    }
  });

  test('a different key creates a separate watcher', async () => {
    await createOrReschedule({
      threadId: 't1',
      userId: 'u',
      key: 'build',
      label: 'b',
      delayMs: 90_000,
    });
    await createOrReschedule({
      threadId: 't1',
      userId: 'u',
      key: 'ci',
      label: 'c',
      delayMs: 90_000,
    });
    expect(rows.size).toBe(2);
  });

  test('clamps a sub-minute delay to the 60s minimum', async () => {
    const w = await createOrReschedule({
      threadId: 't1',
      userId: 'u',
      key: 'k',
      label: 'k',
      delayMs: 1_000,
    });
    expect(w.lastDelayMs).toBe(60_000);
  });

  test('applies default maxWakes when omitted', async () => {
    const w = await createOrReschedule({
      threadId: 't1',
      userId: 'u',
      key: 'k',
      label: 'k',
      delayMs: 90_000,
    });
    expect(w.maxWakes).toBe(20);
    expect(w.deadline).toBeGreaterThan(w.nextWakeAt); // 1h default > the wake
  });
});

describe('watcher scanner lifecycle', () => {
  test('does not keep polling the repository when there are no pending watchers', async () => {
    vi.useFakeTimers();
    const listPending = vi.spyOn(fakeWatchers, 'listPendingWatchers');
    const listDue = vi.spyOn(fakeWatchers, 'listDueWatchers');

    startAgentWatchers();
    await flushMicrotasks();

    expect(listPending).toHaveBeenCalledTimes(1);
    await advanceTimersByTimeAsync(60_000);
    expect(listPending).toHaveBeenCalledTimes(1);
    expect(listDue).not.toHaveBeenCalled();
  });

  test('arms a one-shot timer immediately when a watcher is created', async () => {
    vi.useFakeTimers();
    const listDue = vi.spyOn(fakeWatchers, 'listDueWatchers');

    startAgentWatchers();
    await flushMicrotasks();
    await createOrReschedule({
      threadId: 't1',
      userId: 'u',
      key: 'build',
      label: 'build',
      delayMs: 60_000,
    });

    await advanceTimersByTimeAsync(59_999);
    expect(listDue).not.toHaveBeenCalled();
    await advanceTimersByTimeAsync(1);
    expect(listDue).toHaveBeenCalledTimes(1);
  });
});

describe('watcher firing', () => {
  test('a watcher cancelled after the scan read it does not wake the agent', async () => {
    vi.useFakeTimers();
    const { sendMessage } = await import('../../services/thread-service/messaging.js');
    mocked(sendMessage).mockClear();
    startAgentWatchers();
    const watcher = await createOrReschedule({
      threadId: 't1',
      userId: 'user-1',
      key: 'build',
      label: 'build',
      delayMs: 60_000,
    });
    // The scan lists it as due; the user's cancel lands before it is fired.
    const listDue = fakeWatchers.listDueWatchers;
    let cancelledAfterScan = false;
    fakeWatchers.listDueWatchers = async (now: number) => {
      const due = await listDue(now);
      // Cancel only once the scan really listed it, so the refused fire is exercised.
      if (due.some((w: { id: string }) => w.id === watcher.id)) {
        rows.set(watcher.id, { ...rows.get(watcher.id), status: 'cancelled' });
        cancelledAfterScan = true;
      }
      return due;
    };
    try {
      await advanceTimersByTimeAsync(61_000);
    } finally {
      fakeWatchers.listDueWatchers = listDue;
      vi.useRealTimers();
    }

    expect(cancelledAfterScan).toBe(true);
    expect(rows.get(watcher.id).status).toBe('cancelled');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(emitToUser).not.toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ type: 'watcher:fired' }),
    );
  });

  test('a watcher snoozed after the scan read it is not fired early', async () => {
    vi.useFakeTimers();
    const { sendMessage } = await import('../../services/thread-service/messaging.js');
    mocked(sendMessage).mockClear();
    startAgentWatchers();
    const watcher = await createOrReschedule({
      threadId: 't1',
      userId: 'user-1',
      key: 'snooze',
      label: 'snooze',
      delayMs: 60_000,
    });
    const listDue = fakeWatchers.listDueWatchers;
    let snoozedAfterScan = false;
    fakeWatchers.listDueWatchers = async (now: number) => {
      const due = await listDue(now);
      if (due.some((w: { id: string }) => w.id === watcher.id)) {
        // The agent re-arms it (still pending, later due time) before the fire.
        rows.set(watcher.id, { ...rows.get(watcher.id), nextWakeAt: now + 300_000 });
        snoozedAfterScan = true;
      }
      return due;
    };
    try {
      await advanceTimersByTimeAsync(61_000);
    } finally {
      fakeWatchers.listDueWatchers = listDue;
      vi.useRealTimers();
    }

    expect(snoozedAfterScan).toBe(true);
    expect(rows.get(watcher.id).status).toBe('pending');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

/** Stand-in for vitest's `vi.runAllTicks()`: let pending promise callbacks run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
