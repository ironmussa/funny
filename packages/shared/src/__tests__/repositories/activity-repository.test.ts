import { beforeEach, describe, expect, test } from 'bun:test';

import { createActivityRepository } from '../../repositories/activity-repository.js';
import { createTestDb } from '../helpers/test-db.js';

let repo: ReturnType<typeof createActivityRepository>;

function start(
  id: string,
  over: { userId?: string; runnerId?: string | null; startedAt?: string } = {},
) {
  return repo.insert({
    id,
    userId: over.userId ?? 'user-1',
    runnerId: over.runnerId === undefined ? 'runner-1' : over.runnerId,
    kind: 'project.clone',
    projectId: null,
    threadId: null,
    title: `Clone ${id}`,
    input: { cloneUrl: 'https://github.com/o/r.git', destinationPath: '/tmp/r' },
    startedAt: over.startedAt ?? new Date().toISOString(),
  });
}

beforeEach(() => {
  repo = createActivityRepository(createTestDb());
});

describe('insert', () => {
  test('stores a running activity and round-trips its input', async () => {
    expect((await start('a1')).inserted).toBe(true);
    const a = await repo.getById('a1');
    expect(a?.status).toBe('running');
    expect(a?.input).toEqual({ cloneUrl: 'https://github.com/o/r.git', destinationPath: '/tmp/r' });
    expect(a?.resultRef).toBeNull();
  });

  test('a repeated start does not overwrite the row', async () => {
    await start('a1');
    await repo.update('a1', { status: 'failed', error: 'boom' });
    expect((await start('a1')).inserted).toBe(false);
    expect((await repo.getById('a1'))?.status).toBe('failed');
  });
});

describe('update', () => {
  test('applies a legal transition with its result', async () => {
    await start('a1');
    expect(await repo.update('a1', { status: 'succeeded', resultRef: { projectId: 'p1' } })).toBe(
      true,
    );
    const a = await repo.getById('a1');
    expect(a?.status).toBe('succeeded');
    expect(a?.resultRef).toEqual({ projectId: 'p1' });
  });

  test('a refused transition is not applied', async () => {
    await start('a1');
    await repo.update('a1', { status: 'failed', error: 'exists' });
    expect(await repo.update('a1', { status: 'succeeded' })).toBe(false);
    const a = await repo.getById('a1');
    expect(a?.status).toBe('failed');
    expect(a?.error).toBe('exists');
  });

  test('another runner cannot update the row', async () => {
    await start('a1', { runnerId: 'runner-1' });
    expect(await repo.update('a1', { status: 'succeeded' }, 'runner-2')).toBe(false);
    expect((await repo.getById('a1'))?.status).toBe('running');
  });
});

describe('reconcile', () => {
  test('interrupts running rows the runner does not list, leaving listed ones', async () => {
    await start('live');
    await start('gone');
    await start('other', { runnerId: 'runner-2' });
    await start('done');
    await repo.update('done', { status: 'succeeded' });

    const changed = await repo.reconcile('runner-1', ['live']);
    expect(changed.map((a) => a.id)).toEqual(['gone']);
    expect((await repo.getById('live'))?.status).toBe('running');
    expect((await repo.getById('gone'))?.status).toBe('interrupted');
    expect((await repo.getById('other'))?.status).toBe('running');
    expect((await repo.getById('done'))?.status).toBe('succeeded');
  });

  test('an empty list interrupts every running row of the runner', async () => {
    await start('a');
    await start('b');
    expect((await repo.reconcile('runner-1', [])).length).toBe(2);
  });

  test('a late terminal report lands on an interrupted row', async () => {
    await start('a');
    await repo.reconcile('runner-1', []);
    expect(await repo.update('a', { status: 'succeeded' })).toBe(true);
    expect(await repo.update('a', { status: 'running' })).toBe(false);
  });
});

describe('list / remove / clear', () => {
  test('lists only the user rows, newest first', async () => {
    await start('old', { startedAt: '2026-01-01T00:00:00.000Z' });
    await start('new', { startedAt: '2026-01-02T00:00:00.000Z' });
    await start('theirs', { userId: 'user-2' });
    expect((await repo.listByUser('user-1')).map((a) => a.id)).toEqual(['new', 'old']);
  });

  test('remove refuses another user row', async () => {
    await start('a', { userId: 'user-2' });
    expect(await repo.remove('a', 'user-1')).toBe(false);
    expect(await repo.remove('a', 'user-2')).toBe(true);
  });

  test('clearFinished keeps running rows', async () => {
    await start('run');
    for (const id of ['s', 'f', 'i']) await start(id);
    await repo.update('s', { status: 'succeeded' });
    await repo.update('f', { status: 'failed' });
    await repo.update('i', { status: 'interrupted' });
    expect((await repo.clearFinished('user-1')).sort()).toEqual(['f', 'i', 's']);
    expect((await repo.listByUser('user-1')).map((a) => a.id)).toEqual(['run']);
  });
});

describe('cap', () => {
  test('deletes only the oldest succeeded rows', async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
    await start('f-old', { startedAt: day(0) });
    await repo.update('f-old', { status: 'failed' });
    await start('s-old', { startedAt: day(1) });
    await repo.update('s-old', { status: 'succeeded' });
    await start('s-new', { startedAt: day(2) });
    await repo.update('s-new', { status: 'succeeded' });
    await start('run', { startedAt: day(3) });

    expect(await repo.enforceCap('user-1', 2)).toEqual(['s-old', 's-new']);
    expect((await repo.listByUser('user-1')).map((a) => a.id).sort()).toEqual(['f-old', 'run']);
  });

  test('keeps every row when none succeeded', async () => {
    await start('a');
    await start('b');
    expect(await repo.enforceCap('user-1', 1)).toEqual([]);
  });
});

describe('origin, effects and instant activities (track-funny-actions)', () => {
  test('a start defaults to origin user with no effects', async () => {
    await start('a1');
    const a = await repo.getById('a1');
    expect(a?.origin).toBe('user');
    expect(a?.effects).toBeNull();
  });

  test('a finished insert is written once and refuses later reports', async () => {
    const startedAt = new Date().toISOString();
    await repo.insert({
      id: 'i1',
      userId: 'user-1',
      runnerId: 'runner-1',
      kind: 'checkout.switch',
      projectId: 'p1',
      threadId: null,
      title: 'Switched to main',
      input: { toBranch: 'main', stashed: false, reason: 'merged' },
      origin: 'implicit',
      effects: [{ effect: 'branch-checked-out', target: 'main' }],
      status: 'succeeded',
      startedAt,
    });
    const a = await repo.getById('i1');
    expect(a?.status).toBe('succeeded');
    expect(a?.endedAt).toBe(startedAt);
    expect(a?.origin).toBe('implicit');
    expect(a?.effects).toEqual([{ effect: 'branch-checked-out', target: 'main' }]);

    expect(await repo.update('i1', { status: 'failed', error: 'late' }, 'runner-1')).toBe(false);
    expect(await repo.update('i1', { step: 'late' }, 'runner-1')).toBe(false);
    expect((await repo.getById('i1'))?.status).toBe('succeeded');
  });

  test('effects are replaced on update', async () => {
    await start('a1');
    await repo.update('a1', { effects: [{ effect: 'command-stopped', target: 'dev' }] });
    await repo.update('a1', {
      status: 'succeeded',
      effects: [
        { effect: 'command-stopped', target: 'dev' },
        { effect: 'worktree-removed', target: '/w' },
      ],
    });
    expect((await repo.getById('a1'))?.effects).toHaveLength(2);
  });

  test('a null runner fences server rows in both directions', async () => {
    await start('server', { runnerId: null });
    await start('runner');
    expect(await repo.update('server', { status: 'succeeded' }, 'runner-1')).toBe(false);
    expect(await repo.update('runner', { status: 'succeeded' }, null)).toBe(false);
    expect(await repo.update('server', { status: 'succeeded' }, null)).toBe(true);
    expect((await repo.getById('runner'))?.status).toBe('running');
  });

  test('server start interrupts only server rows', async () => {
    await start('server', { runnerId: null });
    await start('runner');
    const changed = await repo.interruptServerActivities();
    expect(changed.map((a) => a.id)).toEqual(['server']);
    expect((await repo.getById('server'))?.status).toBe('interrupted');
    expect((await repo.getById('runner'))?.status).toBe('running');
  });
});

describe('undo snapshot reference (track-user-and-scheduled-actions)', () => {
  test('round-trips resultRef.snapshot', async () => {
    await start('s1');
    await repo.update('s1', {
      status: 'succeeded',
      resultRef: { projectId: 'p1', snapshot: 'refs/funny/undo/s1' },
    });
    expect((await repo.getById('s1'))?.resultRef).toEqual({
      projectId: 'p1',
      snapshot: 'refs/funny/undo/s1',
    });
  });
});
