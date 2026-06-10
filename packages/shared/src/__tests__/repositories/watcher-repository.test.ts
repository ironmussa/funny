import { describe, test, expect, beforeEach } from 'bun:test';

import { createWatcherRepository, type WatcherRow } from '../../repositories/watcher-repository.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

let deps: ReturnType<typeof createTestDb>;
let repo: ReturnType<typeof createWatcherRepository>;

function makeRow(over: Partial<WatcherRow> = {}): WatcherRow {
  return {
    id: over.id ?? 'w1',
    threadId: over.threadId ?? 't1',
    userId: over.userId ?? 'user-1',
    key: over.key ?? 'build',
    label: over.label ?? 'build',
    nextWakeAt: over.nextWakeAt ?? 1000,
    lastDelayMs: over.lastDelayMs ?? 60_000,
    wakeCount: over.wakeCount ?? 0,
    maxWakes: over.maxWakes ?? 20,
    deadline: over.deadline ?? null,
    status: over.status ?? 'pending',
    createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: over.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  deps = createTestDb();
  repo = createWatcherRepository(deps);
  seedProject(deps.db);
  seedThread(deps.db, { id: 't1' });
  seedThread(deps.db, { id: 't2' });
  seedThread(deps.db, { id: 't3', userId: 'user-2' });
});

describe('insert / getById', () => {
  test('round-trips a watcher row', async () => {
    await repo.insert(makeRow({ id: 'w1' }));
    const stored = await repo.getById('w1');
    expect(stored?.id).toBe('w1');
    expect(stored?.status).toBe('pending');
    expect(stored?.nextWakeAt).toBe(1000);
  });
});

describe('getLiveByThreadKey', () => {
  test('returns a pending or fired watcher for (threadId, key)', async () => {
    await repo.insert(makeRow({ id: 'w1', threadId: 't1', key: 'build', status: 'pending' }));
    const live = await repo.getLiveByThreadKey('t1', 'build');
    expect(live?.id).toBe('w1');
  });

  test('ignores terminal watchers (done/cancelled/expired) — lets a new one be created', async () => {
    await repo.insert(makeRow({ id: 'w1', threadId: 't1', key: 'build', status: 'cancelled' }));
    await repo.insert(makeRow({ id: 'w2', threadId: 't1', key: 'ci', status: 'expired' }));
    expect(await repo.getLiveByThreadKey('t1', 'build')).toBeUndefined();
    expect(await repo.getLiveByThreadKey('t1', 'ci')).toBeUndefined();
  });

  test('does not match a different thread or key', async () => {
    await repo.insert(makeRow({ id: 'w1', threadId: 't1', key: 'build' }));
    expect(await repo.getLiveByThreadKey('t2', 'build')).toBeUndefined();
    expect(await repo.getLiveByThreadKey('t1', 'other')).toBeUndefined();
  });
});

describe('listDue', () => {
  test('returns only pending watchers whose nextWakeAt <= now', async () => {
    await repo.insert(makeRow({ id: 'due', nextWakeAt: 500, status: 'pending' }));
    await repo.insert(makeRow({ id: 'future', key: 'k2', nextWakeAt: 5000, status: 'pending' }));
    await repo.insert(makeRow({ id: 'fired', key: 'k3', nextWakeAt: 500, status: 'fired' }));

    const due = await repo.listDue(1000);
    expect(due.map((w) => w.id)).toEqual(['due']);
  });

  test('catch-up: a watcher overdue by many intervals is still due on the next scan', async () => {
    // Simulates the runner being down past the scheduled wake.
    await repo.insert(makeRow({ id: 'overdue', nextWakeAt: 1000, status: 'pending' }));
    const due = await repo.listDue(9_999_999);
    expect(due.map((w) => w.id)).toEqual(['overdue']);
  });

  test('scopes to a user when userId is provided (runner isolation)', async () => {
    await repo.insert(makeRow({ id: 'u1', threadId: 't1', userId: 'user-1', nextWakeAt: 500 }));
    await repo.insert(makeRow({ id: 'u2', threadId: 't3', userId: 'user-2', nextWakeAt: 500 }));

    const all = await repo.listDue(1000);
    expect(all.map((w) => w.id).sort()).toEqual(['u1', 'u2']);

    const scoped = await repo.listDue(1000, 'user-1');
    expect(scoped.map((w) => w.id)).toEqual(['u1']);
  });
});

describe('listPending', () => {
  test('returns pending rows, optionally scoped to a user', async () => {
    await repo.insert(makeRow({ id: 'p1', threadId: 't1', userId: 'user-1', status: 'pending' }));
    await repo.insert(
      makeRow({ id: 'p2', threadId: 't3', userId: 'user-2', key: 'k2', status: 'pending' }),
    );
    await repo.insert(makeRow({ id: 'done', threadId: 't1', key: 'k3', status: 'done' }));

    expect((await repo.listPending()).map((w) => w.id).sort()).toEqual(['p1', 'p2']);
    expect((await repo.listPending('user-1')).map((w) => w.id)).toEqual(['p1']);
  });
});

describe('update', () => {
  test('reschedule: advances nextWakeAt and re-arms status', async () => {
    await repo.insert(makeRow({ id: 'w1', nextWakeAt: 1000, status: 'fired', wakeCount: 1 }));
    await repo.update('w1', { nextWakeAt: 2000, status: 'pending', lastDelayMs: 1000 });
    const w = await repo.getById('w1');
    expect(w?.nextWakeAt).toBe(2000);
    expect(w?.status).toBe('pending');
    expect(w?.wakeCount).toBe(1); // preserved
  });

  test('expire: terminal status removes it from listDue', async () => {
    await repo.insert(makeRow({ id: 'w1', nextWakeAt: 500, status: 'pending' }));
    await repo.update('w1', { status: 'expired' });
    expect((await repo.listDue(1000)).length).toBe(0);
  });
});

describe('deleteByThread', () => {
  test('removes all of a thread’s watchers', async () => {
    await repo.insert(makeRow({ id: 'w1', threadId: 't1', key: 'a' }));
    await repo.insert(makeRow({ id: 'w2', threadId: 't1', key: 'b' }));
    await repo.insert(makeRow({ id: 'w3', threadId: 't2', key: 'a' }));

    await repo.deleteByThread('t1');
    expect(await repo.getById('w1')).toBeUndefined();
    expect(await repo.getById('w2')).toBeUndefined();
    expect((await repo.getById('w3'))?.id).toBe('w3');
  });
});
