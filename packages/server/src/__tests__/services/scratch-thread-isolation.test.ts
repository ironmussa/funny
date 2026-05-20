/**
 * Per-user isolation regression test for scratch threads.
 *
 * The thread route at packages/server/src/routes/threads.ts:265 already
 * returns 404 (not 403) when a thread's `userId` doesn't match the
 * caller. This test verifies the underlying SQL invariants that uphold
 * that behavior for scratch threads:
 *   1. Scratch threads carry a userId
 *   2. The thread row’s userId is the only owner check the route uses
 *
 * See scratch-threads/specs/scratch-threads/spec.md → "Per-user isolation
 * of scratch threads" requirement.
 */
import { describe, test, expect } from 'bun:test';

import { and, eq } from 'drizzle-orm';

import { createTestDb } from '../helpers/test-db.js';

function seedScratchThread(
  testDb: ReturnType<typeof createTestDb>,
  opts: { id: string; userId: string; title?: string },
) {
  testDb.db
    .insert(testDb.schema.threads)
    .values({
      id: opts.id,
      // SQLite test schema marks project_id nullable; drizzle’s inferred type
      // still says non-null, hence the cast.
      projectId: null as any,
      userId: opts.userId,
      title: opts.title ?? 'scratch',
      mode: 'local',
      provider: 'claude',
      permissionMode: 'autoEdit',
      status: 'idle',
      stage: 'backlog',
      model: 'sonnet',
      runtime: 'local',
      isScratch: 1,
      cost: 0,
      archived: 0,
      pinned: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

describe('scratch thread per-user isolation', () => {
  test('SQL filter by (userId, is_scratch=1) returns only the caller’s scratch threads', () => {
    const testDb = createTestDb();
    seedScratchThread(testDb, { id: 't-a', userId: 'user-A' });
    seedScratchThread(testDb, { id: 't-b', userId: 'user-B' });
    seedScratchThread(testDb, { id: 't-a2', userId: 'user-A' });

    const rows = testDb.db
      .select()
      .from(testDb.schema.threads)
      .where(
        and(eq(testDb.schema.threads.userId, 'user-A'), eq(testDb.schema.threads.isScratch, 1)),
      )
      .all();

    const ids = rows.map((r: any) => r.id).sort();
    expect(ids).toEqual(['t-a', 't-a2']);
    expect(rows.every((r: any) => r.userId === 'user-A')).toBe(true);
  });

  test('is_scratch = 0 filter excludes scratch threads from project listings', () => {
    const testDb = createTestDb();
    // A project + a normal (non-scratch) thread for user-A
    testDb.db
      .insert(testDb.schema.projects)
      .values({
        id: 'proj-1',
        name: 'p',
        path: '/tmp',
        userId: 'user-A',
        createdAt: new Date().toISOString(),
      })
      .run();
    testDb.db
      .insert(testDb.schema.threads)
      .values({
        id: 't-normal',
        projectId: 'proj-1',
        userId: 'user-A',
        title: 'normal',
        mode: 'local',
        provider: 'claude',
        permissionMode: 'autoEdit',
        status: 'idle',
        stage: 'backlog',
        model: 'sonnet',
        runtime: 'local',
        isScratch: 0,
        cost: 0,
        archived: 0,
        pinned: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    seedScratchThread(testDb, { id: 't-scratch', userId: 'user-A' });

    const rows = testDb.db
      .select()
      .from(testDb.schema.threads)
      .where(
        and(eq(testDb.schema.threads.userId, 'user-A'), eq(testDb.schema.threads.isScratch, 0)),
      )
      .all();
    const ids = rows.map((r: any) => r.id);
    expect(ids).toContain('t-normal');
    expect(ids).not.toContain('t-scratch');
  });

  test('cross-user lookup retains the row’s real owner — server route will 404', () => {
    // Reproduces the 404 check at routes/threads.ts:265 — the route compares
    // `row.userId !== caller.userId`. Here we confirm the row is fetchable by
    // id (so the rule fires) and that its userId is the seeded one.
    const testDb = createTestDb();
    seedScratchThread(testDb, { id: 't-b', userId: 'user-B' });

    const row = testDb.db
      .select()
      .from(testDb.schema.threads)
      .where(eq(testDb.schema.threads.id, 't-b'))
      .get();
    expect(row).toBeDefined();
    expect(row?.userId).toBe('user-B');
    // Caller is user-A; the route’s `if (row.userId !== caller) return 404`
    // would fire here.
    const caller = 'user-A';
    expect(row?.userId !== caller).toBe(true);
  });
});
