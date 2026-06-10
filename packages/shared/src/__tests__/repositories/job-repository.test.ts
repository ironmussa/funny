import { describe, test, expect, beforeEach } from 'bun:test';

import { createJobRepository, type JobRow } from '../../repositories/job-repository.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

let deps: ReturnType<typeof createTestDb>;
let repo: ReturnType<typeof createJobRepository>;

function makeRow(over: Partial<JobRow> = {}): JobRow {
  return {
    id: over.id ?? 'j1',
    threadId: over.threadId ?? 't1',
    userId: over.userId ?? 'user-1',
    command: over.command ?? 'sleep 60',
    cwd: over.cwd ?? null,
    label: over.label ?? null,
    pid: over.pid ?? 12345,
    logPath: over.logPath ?? '/tmp/j1/log',
    exitPath: over.exitPath ?? '/tmp/j1/exit',
    status: over.status ?? 'running',
    exitCode: over.exitCode ?? null,
    startedAt: over.startedAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: over.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  deps = createTestDb();
  repo = createJobRepository(deps);
  seedProject(deps.db);
  seedThread(deps.db, { id: 't1' });
  seedThread(deps.db, { id: 't2' });
  seedThread(deps.db, { id: 't3', userId: 'user-2' });
});

describe('insert / getById', () => {
  test('round-trips a job row', async () => {
    await repo.insert(makeRow({ id: 'j1', command: 'npm run build' }));
    const stored = await repo.getById('j1');
    expect(stored?.id).toBe('j1');
    expect(stored?.command).toBe('npm run build');
    expect(stored?.status).toBe('running');
  });
});

describe('listRunning', () => {
  test('returns only running jobs', async () => {
    await repo.insert(makeRow({ id: 'run', status: 'running' }));
    await repo.insert(makeRow({ id: 'done', threadId: 't2', status: 'exited', exitCode: 0 }));
    const running = await repo.listRunning();
    expect(running.map((j) => j.id)).toEqual(['run']);
  });

  test('scopes to a user (runner isolation)', async () => {
    await repo.insert(makeRow({ id: 'u1', threadId: 't1', userId: 'user-1', status: 'running' }));
    await repo.insert(makeRow({ id: 'u2', threadId: 't3', userId: 'user-2', status: 'running' }));

    expect((await repo.listRunning()).map((j) => j.id).sort()).toEqual(['u1', 'u2']);
    expect((await repo.listRunning('user-1')).map((j) => j.id)).toEqual(['u1']);
  });
});

describe('update', () => {
  test('terminal transition removes it from listRunning', async () => {
    await repo.insert(makeRow({ id: 'j1', status: 'running' }));
    await repo.update('j1', { status: 'exited', exitCode: 0 });
    expect((await repo.listRunning()).length).toBe(0);
    const j = await repo.getById('j1');
    expect(j?.status).toBe('exited');
    expect(j?.exitCode).toBe(0);
  });
});

describe('deleteByThread', () => {
  test('removes all of a thread’s jobs', async () => {
    await repo.insert(makeRow({ id: 'j1', threadId: 't1' }));
    await repo.insert(makeRow({ id: 'j2', threadId: 't1', command: 'x' }));
    await repo.insert(makeRow({ id: 'j3', threadId: 't2' }));

    await repo.deleteByThread('t1');
    expect(await repo.getById('j1')).toBeUndefined();
    expect(await repo.getById('j2')).toBeUndefined();
    expect((await repo.getById('j3'))?.id).toBe('j3');
  });
});
