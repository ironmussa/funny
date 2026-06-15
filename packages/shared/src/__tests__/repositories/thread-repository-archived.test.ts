import { beforeEach, describe, expect, test } from 'bun:test';

import { createCommentRepository } from '../../repositories/comment-repository.js';
import { createStageHistoryRepository } from '../../repositories/stage-history.js';
import { createThreadRepository } from '../../repositories/thread-repository.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

let deps: ReturnType<typeof createTestDb>;
let repo: ReturnType<typeof createThreadRepository>;

beforeEach(() => {
  deps = createTestDb();
  const { db, schema, dbAll, dbGet, dbRun } = deps;
  const commentRepo = createCommentRepository({ db, schema, dbAll, dbRun } as any);
  const stageHistoryRepo = createStageHistoryRepository({ db, schema, dbRun } as any);
  repo = createThreadRepository({
    db,
    schema,
    dbAll,
    dbGet,
    dbRun,
    commentRepo,
    stageHistoryRepo,
  } as any);

  seedProject(db, { id: 'p1', userId: 'u1' });
  seedProject(db, { id: 'p2', userId: 'u1' });
  // Archived in two different projects + one non-archived in p1.
  seedThread(db, { id: 'a1', projectId: 'p1', userId: 'u1', archived: 1, title: 'p1 archived' });
  seedThread(db, { id: 'a2', projectId: 'p2', userId: 'u1', archived: 1, title: 'p2 archived' });
  seedThread(db, { id: 'live', projectId: 'p1', userId: 'u1', archived: 0, title: 'p1 live' });
});

describe('listArchivedThreads', () => {
  test('scopes to a single project when projectId is given', async () => {
    const { threads, total } = await repo.listArchivedThreads({
      page: 1,
      limit: 100,
      search: '',
      userId: 'u1',
      projectId: 'p1',
    });
    expect(total).toBe(1);
    expect(threads.map((t) => t.id)).toEqual(['a1']);
  });

  test('returns every project when projectId is omitted', async () => {
    const { threads, total } = await repo.listArchivedThreads({
      page: 1,
      limit: 100,
      search: '',
      userId: 'u1',
    });
    expect(total).toBe(2);
    expect(threads.map((t) => t.id).sort()).toEqual(['a1', 'a2']);
  });
});
