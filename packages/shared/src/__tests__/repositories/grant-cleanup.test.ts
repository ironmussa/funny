/**
 * Grant cleanup-on-delete (unified-rbac-grants, Phase 6). `resource_grants` is
 * polymorphic and does NOT cascade, so `deleteThread` must purge thread grants.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { createCommentRepository } from '../../repositories/comment-repository.js';
import { createGrantRepository } from '../../repositories/grant-repository.js';
import { createStageHistoryRepository } from '../../repositories/stage-history.js';
import { createThreadRepository } from '../../repositories/thread-repository.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

describe('deleteThread purges thread grants', () => {
  let deps: ReturnType<typeof createTestDb>;
  let threadRepo: ReturnType<typeof createThreadRepository>;
  let grants: ReturnType<typeof createGrantRepository>;

  beforeEach(() => {
    deps = createTestDb();
    const { db, schema, dbAll, dbGet, dbRun } = deps;
    const commentRepo = createCommentRepository({ db, schema, dbAll, dbRun } as any);
    const stageHistoryRepo = createStageHistoryRepository({ db, schema, dbRun } as any);
    threadRepo = createThreadRepository({
      db,
      schema,
      dbAll,
      dbGet,
      dbRun,
      commentRepo,
      stageHistoryRepo,
    } as any);
    grants = createGrantRepository(deps);
    seedProject(db, { id: 'p1', userId: 'u1' });
    seedThread(db, { id: 't1', projectId: 'p1', userId: 'u1' });
  });

  test('a thread grant is gone after the thread is deleted (no orphan)', async () => {
    await grants.upsertGrant({
      subjectId: 'ana',
      resourceType: 'thread',
      resourceId: 't1',
      role: 'contributor',
      grantedBy: 'u1',
    });
    expect(await grants.getGrantRole('ana', 'thread', 't1')).toBe('contributor');

    await threadRepo.deleteThread('t1');

    expect(await grants.getGrantRole('ana', 'thread', 't1')).toBeNull();
  });
});
