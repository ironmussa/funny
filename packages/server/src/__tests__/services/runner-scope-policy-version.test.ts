/**
 * Routing-policy caches across server instances (Phase 2 of
 * docs/plans/cloudflare-portability.md). Two module instances of
 * runner-scope share one database, as two server processes would: a change
 * made through one must apply to the other on its next read, not after the
 * 30 s cache TTL.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

import * as instanceA from '../../services/runner-scope.js';
import { createTestDb, seedProject, seedRunner } from '../helpers/test-db.js';

type RunnerScope = typeof import('../../services/runner-scope.js');

let testDb: ReturnType<typeof createTestDb>;
let instanceB: RunnerScope;
let instanceCounter = 0;

async function freshInstance(): Promise<RunnerScope> {
  // A distinct query string is a separate module instance (separate caches)
  // over the same `db` module — what a second server process looks like.
  const specifier = `../../services/runner-scope.ts?instance=${++instanceCounter}`;
  return (await import(specifier)) as RunnerScope;
}

function runner(id: string, role: 'general' | 'dedicated') {
  seedRunner(testDb.db, {
    id,
    userId: 'alice',
    token: `tok-${id}`,
    hostname: id,
    httpUrl: null,
    role,
    status: 'online',
  });
}

beforeEach(async () => {
  testDb = createTestDb();
  const { setConnection } = await import('../../db/index.js');
  setConnection({
    db: testDb.db as any,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  instanceA.__resetRunnerScopeCache();
  instanceB = await freshInstance();
  seedProject(testDb.db, { id: 'p1', userId: 'alice', path: '/srv/p1' });
  runner('r-pinned', 'dedicated');
  runner('r-other', 'dedicated');
  runner('r-general', 'general');
  expect((await instanceA.setProjectDedicatedRunner('p1', 'alice', 'r-pinned')).ok).toBe(true);
});

afterEach(() => {
  testDb.sqlite.close();
});

describe('runner policy version', () => {
  test('a grant revoked on one instance is refused by the other on its next read', async () => {
    expect(await instanceA.grantProjectRunner('p1', 'alice', 'r-other')).toBe(true);
    // Instance B caches "r-other may serve p1".
    expect(await instanceB.canRunnerAccessProject('r-other', 'p1')).toBe(true);

    expect((await instanceA.revokeProjectRunner('p1', 'alice', 'r-other')).ok).toBe(true);

    // No TTL wait: B sees the bumped version and drops its cached policy.
    expect(await instanceB.canRunnerAccessProject('r-other', 'p1')).toBe(false);
  });

  test('re-pinning a project on one instance re-routes the other', async () => {
    expect(await instanceB.pinnedRunnerIdsForProject('p1', 'alice')).toEqual(['r-pinned']);
    await instanceA.setProjectDedicatedRunner('p1', 'alice', 'r-other');
    expect(await instanceB.pinnedRunnerIdsForProject('p1', 'alice')).toEqual(['r-other']);
  });

  test('a runner role change on one instance applies to the other', async () => {
    expect(await instanceB.canRunnerServeProjectless('r-general')).toBe(true);
    await instanceA.setRunnerRole('r-general', 'dedicated');
    expect(await instanceB.canRunnerServeProjectless('r-general')).toBe(false);
  });

  test('a deleted runner is no longer served from the other instance cache', async () => {
    expect(await instanceB.canRunnerServeProjectless('r-general')).toBe(true);
    const { removeRunner } = await import('../../services/runner-manager.js');
    await removeRunner('r-general');
    expect(await instanceB.canRunnerServeProjectless('r-general')).toBe(false);
  });

  test('without a readable version the caches are bypassed (fail closed to the DB)', async () => {
    expect(await instanceA.grantProjectRunner('p1', 'alice', 'r-other')).toBe(true);
    expect(await instanceB.canRunnerAccessProject('r-other', 'p1')).toBe(true);

    testDb.db.run(sql`DROP TABLE runner_policy_version`);
    // The revoke cannot bump the version; instance B must still not serve its
    // cached grant, because it cannot prove the cache is current.
    await instanceA.revokeProjectRunner('p1', 'alice', 'r-other');
    expect(await instanceB.canRunnerAccessProject('r-other', 'p1')).toBe(false);
  });

  test('without the version row the caches are bypassed too', async () => {
    expect(await instanceA.grantProjectRunner('p1', 'alice', 'r-other')).toBe(true);
    expect(await instanceB.canRunnerAccessProject('r-other', 'p1')).toBe(true);

    testDb.db.run(sql`DELETE FROM runner_policy_version`);
    await instanceA.revokeProjectRunner('p1', 'alice', 'r-other');
    expect(await instanceB.canRunnerAccessProject('r-other', 'p1')).toBe(false);
  });

  test('reads are served from the cache while the version is unchanged', async () => {
    expect(await instanceB.canRunnerServeProjectless('r-general')).toBe(true);
    // A write that bypasses runner-scope (no version bump) is not seen until
    // the version moves or the TTL expires — the cache is really used.
    testDb.db.run(sql`UPDATE runners SET role = 'dedicated' WHERE id = 'r-general'`);
    expect(await instanceB.canRunnerServeProjectless('r-general')).toBe(true);
    await instanceA.setRunnerRole('r-other', 'dedicated');
    expect(await instanceB.canRunnerServeProjectless('r-general')).toBe(false);
  });
});
