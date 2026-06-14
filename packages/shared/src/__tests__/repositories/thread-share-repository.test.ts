import { describe, test, expect, beforeEach } from 'bun:test';

import { createThreadShareRepository } from '../../repositories/thread-share-repository.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

let deps: ReturnType<typeof createTestDb>;
let repo: ReturnType<typeof createThreadShareRepository>;

beforeEach(() => {
  deps = createTestDb();
  repo = createThreadShareRepository(deps);
  seedProject(deps.db, { id: 'p1', userId: 'owner-1' });
  seedThread(deps.db, { id: 't1', projectId: 'p1', userId: 'owner-1' });
});

describe('thread-share-repository', () => {
  test('create → hasShare true → list → delete → hasShare false', async () => {
    expect(await repo.hasShare('t1', 'ana')).toBe(false);

    const grant = await repo.createShare({
      threadId: 't1',
      sharedWithUserId: 'ana',
      sharedByUserId: 'owner-1',
    });
    expect(grant.alreadyExisted).toBe(false);

    expect(await repo.hasShare('t1', 'ana')).toBe(true);

    const list = await repo.listSharesForThread('t1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      threadId: 't1',
      sharedWithUserId: 'ana',
      sharedByUserId: 'owner-1',
    });

    await repo.deleteShare('t1', 'ana');
    expect(await repo.hasShare('t1', 'ana')).toBe(false);
    expect(await repo.listSharesForThread('t1')).toHaveLength(0);
  });

  test('createShare is idempotent on the same (thread, user) pair', async () => {
    await repo.createShare({ threadId: 't1', sharedWithUserId: 'ana', sharedByUserId: 'owner-1' });
    const second = await repo.createShare({
      threadId: 't1',
      sharedWithUserId: 'ana',
      sharedByUserId: 'owner-1',
    });
    expect(second.alreadyExisted).toBe(true);
    expect(await repo.listSharesForThread('t1')).toHaveLength(1);
  });

  test('listThreadsSharedWithUser returns the joined thread rows', async () => {
    seedThread(deps.db, { id: 't2', projectId: 'p1', userId: 'owner-1', title: 'Second' });
    await repo.createShare({ threadId: 't1', sharedWithUserId: 'ana', sharedByUserId: 'owner-1' });
    await repo.createShare({ threadId: 't2', sharedWithUserId: 'ana', sharedByUserId: 'owner-1' });
    // A grant for a different user must not leak into ana's feed.
    await repo.createShare({ threadId: 't1', sharedWithUserId: 'bob', sharedByUserId: 'owner-1' });

    const shared = await repo.listThreadsSharedWithUser('ana');
    expect(shared).toHaveLength(2);
    const ids = shared.map((t: any) => t.id).sort();
    expect(ids).toEqual(['t1', 't2']);
    // Joined rows carry full thread data, not just the grant.
    expect(shared.find((t: any) => t.id === 't2')?.title).toBe('Second');
  });

  test('deleting the thread cascades its share grants (ON DELETE CASCADE)', async () => {
    await repo.createShare({ threadId: 't1', sharedWithUserId: 'ana', sharedByUserId: 'owner-1' });
    deps.sqlite.run("DELETE FROM threads WHERE id = 't1'");
    expect(await repo.hasShare('t1', 'ana')).toBe(false);
  });
});
