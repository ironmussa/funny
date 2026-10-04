import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createMigrationContext, migrateThreadSessions } from '../../db/migrate.js';
import { createCommentRepository } from '../../repositories/comment-repository.js';
import { createStageHistoryRepository } from '../../repositories/stage-history.js';
import { createThreadRepository } from '../../repositories/thread-repository.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

let deps: ReturnType<typeof createTestDb>;
let repo: ReturnType<typeof createThreadRepository>;
beforeEach(() => {
  deps = createTestDb();
  repo = createThreadRepository({
    ...deps,
    commentRepo: createCommentRepository(deps),
    stageHistoryRepo: createStageHistoryRepository(deps),
  });
  seedProject(deps.db, { id: 'p1' });
  seedThread(deps.db, { id: 'original', sessionId: 'claude-old' });
});
afterEach(() => deps.sqlite.close());

describe('session ownership', () => {
  test('retains sessions across provider changes, model changes and recovery', async () => {
    await repo.updateThread('original', { sessionId: null, provider: 'codex' });
    expect((await repo.getThreadBySessionId('claude-old'))?.id).toBe('original');
    await repo.updateThread('original', { sessionId: 'codex-new' });
    await repo.updateThread('original', { sessionId: null, model: 'other-model' });
    await repo.updateThread('original', { sessionId: 'recovered' });
    await repo.updateThread('original', { sessionId: 'recovered' });
    for (const session of ['claude-old', 'codex-new', 'recovered']) {
      expect((await repo.getThreadBySessionId(session))?.id).toBe('original');
    }
    expect((await repo.getThread('original'))?.sessionId).toBe('recovered');
    expect(deps.sqlite.query('SELECT * FROM thread_sessions').all()).toHaveLength(3);
    expect(await repo.getThreadBySessionId('truly-external')).toBeUndefined();
  });

  test('prefers original ownership over an existing external duplicate, even when archived', async () => {
    await repo.updateThread('original', { sessionId: 'codex-new', archived: 1 });
    seedThread(deps.db, { id: 'duplicate', sessionId: 'claude-old', createdBy: 'external' });
    expect((await repo.getThreadBySessionId('claude-old'))?.id).toBe('original');
  });

  test('backfills existing sessions idempotently and cascades deletion', async () => {
    deps.sqlite.exec('DROP TABLE thread_sessions');
    seedThread(deps.db, { id: 'no-session', sessionId: null });
    seedThread(deps.db, { id: 'empty-session', sessionId: '' });
    const { exec } = createMigrationContext(deps.db);
    await migrateThreadSessions(exec);
    await migrateThreadSessions(exec);
    expect(deps.sqlite.query('SELECT * FROM thread_sessions').all()).toEqual([
      { thread_id: 'original', session_id: 'claude-old' },
    ]);
    await repo.deleteThread('original');
    expect(await repo.getThreadBySessionId('claude-old')).toBeUndefined();
    expect(deps.sqlite.query('SELECT * FROM thread_sessions').all()).toHaveLength(0);
  });
});
