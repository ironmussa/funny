import { describe, test, expect, beforeEach, vi } from 'vitest';

// ── Mock the manager's dependencies ──────────────────────────────
// Shared mock state lives in vi.hoisted so the (hoisted) vi.mock factories
// can reference it. `rows` is an in-memory fake of IWatcherRepository.
const { rows, fakeWatchers, emitToUser } = vi.hoisted(() => {
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
    async updateWatcher(id: string, patch: any) {
      const cur = rows.get(id);
      if (cur) rows.set(id, { ...cur, ...patch });
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
});

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

import { createOrReschedule } from '../../services/agent-watcher-manager.js';

beforeEach(() => {
  rows.clear();
  emitToUser.mockClear();
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
