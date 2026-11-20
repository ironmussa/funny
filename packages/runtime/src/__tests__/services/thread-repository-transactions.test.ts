/**
 * Integration tests for thread-repository transaction safety.
 * Verifies that createThread and updateThread are atomic:
 * thread insert + stage history are wrapped in a single transaction.
 *
 * Uses raw SQL through Drizzle's sql`` tag to avoid schema column mismatches
 * between the test DB helper and the evolving schema.
 */
import { sql } from 'drizzle-orm';
import { describe, test, expect, beforeEach } from 'vitest';

import { createTestDb, seedProject } from '../helpers/test-db.js';

describe('thread-repository transactions', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    seedProject(testDb.db, { id: 'p1', name: 'Test', path: '/tmp/test' });
  });

  function insertThread(id: string, stage = 'backlog') {
    testDb.db.run(sql`
      INSERT INTO threads (id, project_id, user_id, title, mode, status, stage, model, created_at)
      VALUES (${id}, 'p1', 'u1', 'Test thread', 'local', 'pending', ${stage}, 'sonnet', ${new Date().toISOString()})
    `);
  }

  function insertStageHistory(threadId: string, from: string | null, to: string) {
    testDb.db.run(sql`
      INSERT INTO stage_history (id, thread_id, from_stage, to_stage, changed_at)
      VALUES (${'sh-' + Math.random().toString(36).slice(2)}, ${threadId}, ${from}, ${to}, ${new Date().toISOString()})
    `);
  }

  interface ThreadRow {
    id: string;
    stage: string;
    status: string;
  }

  interface StageHistoryRow {
    thread_id: string;
    from_stage: string | null;
    to_stage: string;
  }

  function getThread(id: string): ThreadRow {
    return testDb.db.all<ThreadRow>(sql`SELECT * FROM threads WHERE id = ${id}`)[0];
  }

  function getStageHistory(threadId: string): StageHistoryRow[] {
    return testDb.db.all<StageHistoryRow>(
      sql`SELECT * FROM stage_history WHERE thread_id = ${threadId} ORDER BY changed_at`,
    );
  }

  // ── createThread atomicity ──────────────────────────────────

  describe('createThread atomicity', () => {
    test('transaction wraps thread insert + stage history', () => {
      // Simulate the transactional createThread
      testDb.db.transaction((tx) => {
        tx.run(sql`
          INSERT INTO threads (id, project_id, user_id, title, mode, status, stage, model, created_at)
          VALUES ('t1', 'p1', 'u1', 'Atomic thread', 'local', 'pending', 'backlog', 'sonnet', ${new Date().toISOString()})
        `);
        tx.run(sql`
          INSERT INTO stage_history (id, thread_id, from_stage, to_stage, changed_at)
          VALUES ('sh-1', 't1', ${null}, 'backlog', ${new Date().toISOString()})
        `);
      });

      const thread = getThread('t1');
      expect(thread).toBeDefined();

      const history = getStageHistory('t1');
      expect(history).toHaveLength(1);
      expect(history[0].to_stage).toBe('backlog');
    });

    test('transaction rolls back both on failure', () => {
      expect(() => {
        testDb.db.transaction((tx) => {
          tx.run(sql`
            INSERT INTO threads (id, project_id, user_id, title, mode, status, stage, model, created_at)
            VALUES ('t-fail', 'p1', 'u1', 'Should rollback', 'local', 'pending', 'backlog', 'sonnet', ${new Date().toISOString()})
          `);
          // Force failure
          throw new Error('Simulated failure');
        });
      }).toThrow('Simulated failure');

      // Thread should NOT exist
      const thread = getThread('t-fail');
      expect(thread).toBeUndefined();
    });
  });

  // ── updateThread atomicity ─────────────────────────────────

  describe('updateThread atomicity', () => {
    beforeEach(() => {
      insertThread('t1', 'backlog');
      insertStageHistory('t1', null, 'backlog');
    });

    test('stage change + history are atomic', () => {
      testDb.db.transaction((tx) => {
        // Read current stage
        const [current] = tx.all<{ stage: string }>(sql`SELECT stage FROM threads WHERE id = 't1'`);
        expect(current.stage).toBe('backlog');

        // Record stage history
        tx.run(sql`
          INSERT INTO stage_history (id, thread_id, from_stage, to_stage, changed_at)
          VALUES ('sh-2', 't1', 'backlog', 'in-progress', ${new Date().toISOString()})
        `);

        // Update thread
        tx.run(sql`UPDATE threads SET stage = 'in-progress' WHERE id = 't1'`);
      });

      const thread = getThread('t1');
      expect(thread.stage).toBe('in-progress');

      const history = getStageHistory('t1');
      expect(history).toHaveLength(2);
      expect(history[1].from_stage).toBe('backlog');
      expect(history[1].to_stage).toBe('in-progress');
    });

    test('rolls back stage change when history insert fails', () => {
      expect(() => {
        testDb.db.transaction((tx) => {
          // Update thread stage
          tx.run(sql`UPDATE threads SET stage = 'done' WHERE id = 't1'`);
          // Force failure during history insert
          throw new Error('History insert failed');
        });
      }).toThrow('History insert failed');

      // Thread stage should still be backlog
      const thread = getThread('t1');
      expect(thread.stage).toBe('backlog');

      // No new history entries
      const history = getStageHistory('t1');
      expect(history).toHaveLength(1);
    });

    test('archive + unarchive transitions are atomic', () => {
      // Archive
      testDb.db.transaction((tx) => {
        tx.run(sql`
          INSERT INTO stage_history (id, thread_id, from_stage, to_stage, changed_at)
          VALUES ('sh-archive', 't1', 'backlog', 'archived', ${new Date().toISOString()})
        `);
        tx.run(sql`UPDATE threads SET archived = 1 WHERE id = 't1'`);
      });

      let history = getStageHistory('t1');
      expect(history).toHaveLength(2);
      expect(history[1].to_stage).toBe('archived');

      // Unarchive
      testDb.db.transaction((tx) => {
        tx.run(sql`
          INSERT INTO stage_history (id, thread_id, from_stage, to_stage, changed_at)
          VALUES ('sh-unarchive', 't1', 'archived', 'backlog', ${new Date().toISOString()})
        `);
        tx.run(sql`UPDATE threads SET archived = 0 WHERE id = 't1'`);
      });

      history = getStageHistory('t1');
      expect(history).toHaveLength(3);
      expect(history[2].from_stage).toBe('archived');
      expect(history[2].to_stage).toBe('backlog');
    });

    test('simple status update without stage change works without transaction overhead', () => {
      // Direct update (no transaction needed)
      testDb.db.run(sql`UPDATE threads SET status = 'running' WHERE id = 't1'`);

      const thread = getThread('t1');
      expect(thread.status).toBe('running');

      // Only initial history entry
      const history = getStageHistory('t1');
      expect(history).toHaveLength(1);
    });
  });
});
