/**
 * The `jobs` tRPC port (#231): the caller's jobs come back one page at a time,
 * newest first, as `Job` values rather than raw rows.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { jobListInput } from '@funny/shared/contracts/jobs';

import { jobsPort } from '../../trpc/ports/background.js';

describe('jobs port', () => {
  let db: (typeof import('../../db/index.js'))['db'];
  let schema: typeof import('../../db/schema.js');

  beforeAll(async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    db = (await import('../../db/index.js')).db;
    schema = await import('../../db/schema.js');
  });

  beforeEach(async () => {
    db.run('DELETE FROM jobs');
    db.run('DELETE FROM threads');
    db.run('DELETE FROM projects');
    const now = new Date().toISOString();
    await db.insert(schema.projects).values({
      id: 'p1',
      name: 'p1',
      path: '/p1',
      userId: 'alice',
      createdAt: now,
    });
    await db.insert(schema.threads).values({
      id: 't1',
      projectId: 'p1',
      userId: 'alice',
      title: 't1',
      mode: 'local',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    });
  });

  /** `n` jobs of `userId`, one second apart, `${prefix}0` the oldest. */
  async function seedJobs(n: number, userId = 'alice', prefix = 'j') {
    for (let i = 0; i < n; i++) {
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      await db.insert(schema.jobs).values({
        id: `${prefix}${i}`,
        threadId: 't1',
        userId,
        command: 'sleep 1',
        logPath: '/tmp/log',
        exitPath: '/tmp/exit',
        status: 'running',
        startedAt: at,
        updatedAt: at,
      });
    }
  }

  const ids = async (input?: Parameters<typeof jobListInput.parse>[0]) => {
    const result = await jobsPort.list('alice', jobListInput.parse(input));
    return result._unsafeUnwrap().map((job) => job.id);
  };

  test('a missing input is the first page of 100, newest first', async () => {
    await seedJobs(105);
    const page = await ids();
    expect(page).toHaveLength(100);
    expect(page[0]).toBe('j104');
    expect(page.at(-1)).toBe('j5');
  });

  test('limit and offset walk back through older jobs without overlap', async () => {
    await seedJobs(5);
    expect(await ids({ limit: 2 })).toEqual(['j4', 'j3']);
    expect(await ids({ limit: 2, offset: 2 })).toEqual(['j2', 'j1']);
    expect(await ids({ limit: 2, offset: 4 })).toEqual(['j0']);
  });

  test('refuses a page larger than 500', () => {
    expect(jobListInput.safeParse({ limit: 501 }).success).toBe(false);
  });

  test('lists only the caller jobs, with only the Job fields', async () => {
    await seedJobs(1);
    await seedJobs(1, 'bob', 'bob-');
    const result = await jobsPort.list('alice', jobListInput.parse(undefined));
    const jobs = result._unsafeUnwrap();
    expect(jobs.map((job) => job.id)).toEqual(['j0']);
    expect(Object.keys(jobs[0]).sort()).toEqual(
      [
        'command',
        'cwd',
        'exitCode',
        'exitPath',
        'id',
        'label',
        'logPath',
        'pid',
        'startedAt',
        'status',
        'threadId',
        'updatedAt',
        'userId',
      ].sort(),
    );
  });
});
