/**
 * Migration 131_factory_runs_issue_title_backfill: a run from before 130 takes
 * its issue's title from its implementing thread, so the factory board names it
 * even when that thread is not among the threads the client loaded.
 */
import { describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

describe('131_factory_runs_issue_title_backfill migration', () => {
  test('fills the title from the run own implementing thread, and nothing else', async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const { db } = await import('../../db/index.js');
    const run = (q: ReturnType<typeof sql>) => db.run(q);
    run(sql`PRAGMA foreign_keys = OFF`);

    const thread = (id: string, title: string) =>
      run(
        sql`INSERT INTO threads (id, project_id, user_id, title, mode, created_at)
            VALUES (${id}, 'p1', 'u1', ${title}, 'worktree', '2026-11-24')`,
      );
    const factoryRun = (id: string, issue: number, threadIds: string[] | null, title?: string) =>
      run(
        sql`INSERT INTO factory_runs (id, factory_id, issue_number, issue_title, state, thread_ids, started_at)
            VALUES (${id}, 'f1', ${issue}, ${title ?? null}, 'merged',
                    ${threadIds ? JSON.stringify(threadIds) : null}, '2026-11-24')`,
      );

    thread('t-review', '[Factory review] #485 abcd1234 Clear the core rules');
    thread('t-impl', '[Factory] #485 Clear the core rules (part 3/5 of #462)');
    thread('t-other', '[Factory] #486 Clear the client rules');
    factoryRun('r-old', 485, ['t-review', 't-impl']);
    // Its thread list names another issue's thread only.
    factoryRun('r-foreign', 490, ['t-other']);
    factoryRun('r-kept', 486, ['t-other'], 'Title the run read');
    factoryRun('r-none', 461, null);
    run(sql`DELETE FROM _migrations WHERE name = '131_factory_runs_issue_title_backfill'`);

    await autoMigrate();

    expect(
      db.all<{ id: string; issue_title: string | null }>(
        sql`SELECT id, issue_title FROM factory_runs ORDER BY id`,
      ),
    ).toEqual([
      { id: 'r-foreign', issue_title: null },
      { id: 'r-kept', issue_title: 'Title the run read' },
      { id: 'r-none', issue_title: null },
      { id: 'r-old', issue_title: 'Clear the core rules (part 3/5 of #462)' },
    ]);
  });
});
