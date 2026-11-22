/**
 * Routing-policy caches across server instances (Phase 2 of
 * docs/plans/cloudflare-portability.md). Two module instances of
 * runner-scope share one database, as two server processes would: a change
 * made through one must apply to the other on its next read, not after the
 * 30 s cache TTL.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';

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
  const instance: RunnerScope = await import(specifier);
  return instance;
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
    db: testDb.db,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
  instanceA.__resetRunnerScopeCache();
  instanceB = await freshInstance();
  // These tests read on B right after a change on A; the version memo has
  // its own tests below.
  instanceA.__setRunnerPolicyVersionSyncWindowMs(0);
  instanceB.__setRunnerPolicyVersionSyncWindowMs(0);
  seedProject(testDb.db, { id: 'p1', userId: 'alice', path: '/srv/p1' });
  runner('r-pinned', 'dedicated');
  runner('r-other', 'dedicated');
  runner('r-general', 'general');
  expect((await instanceA.setProjectDedicatedRunner('p1', 'alice', 'r-pinned')).ok).toBe(true);
});

afterEach(() => {
  setSystemTime();
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

describe('runner policy version memo (issue #217)', () => {
  const WINDOW_MS = 1_000;

  beforeEach(() => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    instanceA.__setRunnerPolicyVersionSyncWindowMs(WINDOW_MS);
    instanceB.__setRunnerPolicyVersionSyncWindowMs(WINDOW_MS);
  });

  function advance(ms: number) {
    setSystemTime(new Date(Date.now() + ms));
  }

  test('reads within the window reuse one version read', async () => {
    expect(await instanceB.syncRunnerPolicyVersion()).toBeGreaterThan(0);
    // The version moved in the DB without B being told: B keeps the version
    // it read until the window ends, so it does not query on every read.
    testDb.db.run(sql`UPDATE runner_policy_version SET version = version + 1 WHERE id = 1`);
    const memoised = await instanceB.syncRunnerPolicyVersion();
    advance(WINDOW_MS);
    expect(await instanceB.syncRunnerPolicyVersion()).toBe(memoised + 1);
  });

  test('concurrent reads share one version read', async () => {
    const reads = await Promise.all([
      instanceB.syncRunnerPolicyVersion(),
      instanceB.canRunnerAccessProject('r-pinned', 'p1'),
      instanceB.syncRunnerPolicyVersion(),
    ]);
    expect(reads[0]).toBe(reads[2] as number);
    expect(reads[1]).toBe(true);
  });

  test('a revocation on another instance applies once the window ends', async () => {
    expect(await instanceA.grantProjectRunner('p1', 'alice', 'r-other')).toBe(true);
    expect(await instanceB.canRunnerAccessProject('r-other', 'p1')).toBe(true);

    expect((await instanceA.revokeProjectRunner('p1', 'alice', 'r-other')).ok).toBe(true);

    advance(WINDOW_MS);
    expect(await instanceB.canRunnerAccessProject('r-other', 'p1')).toBe(false);
  });

  test('a change made on this instance applies at once, inside the window', async () => {
    expect(await instanceA.grantProjectRunner('p1', 'alice', 'r-other')).toBe(true);
    expect(await instanceA.canRunnerAccessProject('r-other', 'p1')).toBe(true);

    expect((await instanceA.revokeProjectRunner('p1', 'alice', 'r-other')).ok).toBe(true);
    expect(await instanceA.canRunnerAccessProject('r-other', 'p1')).toBe(false);
  });

  test('an unreadable version is not memoised', async () => {
    expect(await instanceB.canRunnerServeProjectless('r-general')).toBe(true);
    advance(WINDOW_MS);
    testDb.db.run(sql`DELETE FROM runner_policy_version`);
    expect(await instanceB.syncRunnerPolicyVersion()).toBe(-2);
    // The next read inside the window goes to the DB again.
    testDb.db.run(sql`INSERT INTO runner_policy_version (id, version) VALUES (1, 500)`);
    expect(await instanceB.syncRunnerPolicyVersion()).toBe(500);
  });
});
