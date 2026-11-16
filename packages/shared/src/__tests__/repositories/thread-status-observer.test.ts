import { beforeEach, describe, expect, test } from 'bun:test';

import { createCommentRepository } from '../../repositories/comment-repository.js';
import { createStageHistoryRepository } from '../../repositories/stage-history.js';
import { createThreadRepository } from '../../repositories/thread-repository.js';
import { isThreadStatusWriteModelled } from '../../thread-machine.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

type Write = { threadId: string; from: string | null; to: string };

describe('thread repository onStatusWrite', () => {
  let writes: Write[];
  let repo: ReturnType<typeof createThreadRepository>;

  beforeEach(() => {
    writes = [];
    const deps = createTestDb();
    const { db, schema, dbAll, dbGet, dbRun } = deps;
    repo = createThreadRepository({
      db,
      schema,
      dbAll,
      dbGet,
      dbRun,
      commentRepo: createCommentRepository({ db, schema, dbAll, dbRun } as any),
      stageHistoryRepo: createStageHistoryRepository({ db, schema, dbRun } as any),
      onStatusWrite: (write: Write) => writes.push(write),
    } as any);
    seedProject(db, { id: 'p1', userId: 'u1' });
    seedThread(db, { id: 't1', projectId: 'p1', userId: 'u1', status: 'completed' });
  });

  test('is told the status the row had and the one written', async () => {
    await repo.updateThread('t1', { status: 'idle' });
    await repo.updateThread('t1', { status: 'running' });

    expect(writes).toEqual([
      { threadId: 't1', from: 'completed', to: 'idle' },
      { threadId: 't1', from: 'idle', to: 'running' },
    ]);
    expect((await repo.getThread('t1'))?.status).toBe('running'); // nothing is blocked
  });

  test('is not told about writes without a status', async () => {
    await repo.updateThread('t1', { cost: 1 });
    expect(writes).toEqual([]);
  });

  test('a throwing observer does not fail the write', async () => {
    const deps = createTestDb();
    const { db, schema, dbAll, dbGet, dbRun } = deps;
    const throwing = createThreadRepository({
      db,
      schema,
      dbAll,
      dbGet,
      dbRun,
      commentRepo: createCommentRepository({ db, schema, dbAll, dbRun } as any),
      stageHistoryRepo: createStageHistoryRepository({ db, schema, dbRun } as any),
      onStatusWrite: () => {
        throw new Error('observer bug');
      },
    } as any);
    seedProject(db, { id: 'p1', userId: 'u1' });
    seedThread(db, { id: 't1', projectId: 'p1', userId: 'u1', status: 'running' });

    await throwing.updateThread('t1', { status: 'completed' });
    expect((await throwing.getThread('t1'))?.status).toBe('completed');
  });
});

describe('isThreadStatusWriteModelled', () => {
  test('accepts what an event leads to, and a write that changes nothing', () => {
    expect(isThreadStatusWriteModelled('running', 'completed')).toBe(true);
    expect(isThreadStatusWriteModelled('waiting', 'running')).toBe(true);
    expect(isThreadStatusWriteModelled('failed', 'setting_up')).toBe(true);
    expect(isThreadStatusWriteModelled('setting_up', 'pending')).toBe(true);
    expect(isThreadStatusWriteModelled('idle', 'idle')).toBe(true);
    expect(isThreadStatusWriteModelled('stopped', 'waiting')).toBe(true); // WAIT absorbs late results
  });

  test('rejects what no event leads to', () => {
    expect(isThreadStatusWriteModelled('completed', 'idle')).toBe(false); // rewind
    expect(isThreadStatusWriteModelled('completed', 'pending')).toBe(false);
    expect(isThreadStatusWriteModelled('failed', 'idle')).toBe(false);
  });
});
