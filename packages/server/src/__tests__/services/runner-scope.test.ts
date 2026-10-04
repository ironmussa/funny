/**
 * runner-scope.ts — the project-runner-binding access rule (general vs
 * dedicated runners, project override, explicit grants, revocation).
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import {
  __resetRunnerScopeCache,
  canRunnerAccessProject,
  canRunnerServeProjectless,
  evaluateRunnerAccess,
  generalRunnerIdsForUser,
  grantProjectRunner,
  pinnedRunnerIdsForProject,
  revokeProjectRunner,
  setGeneralRunner,
  setProjectDedicatedRunner,
  setRunnerRole,
  type ProjectRunnerPolicy,
  type RunnerScopeRecord,
} from '../../services/runner-scope.js';
import { createTestDb, seedProject, seedRunner } from '../helpers/test-db.js';

let testDb: ReturnType<typeof createTestDb>;

async function bindTestDb() {
  testDb = createTestDb();
  const { setConnection } = await import('../../db/index.js');
  setConnection({
    db: testDb.db as any,
    schema: testDb.schema,
    sqlite: testDb.sqlite,
    mode: 'sqlite',
    close: async () => testDb.sqlite.close(),
  });
}

function runner(id: string, userId: string, role: 'general' | 'dedicated' = 'general') {
  seedRunner(testDb.db, { id, userId, token: `tok-${id}`, hostname: id, role });
}

beforeEach(async () => {
  __resetRunnerScopeCache();
  await bindTestDb();
});

describe('evaluateRunnerAccess (pure rule)', () => {
  const policy = (p: Partial<ProjectRunnerPolicy> = {}): ProjectRunnerPolicy => ({
    projectId: 'p',
    ownerId: 'alice',
    dedicatedRunnerId: null,
    grantedRunnerIds: [],
    ...p,
  });
  const r = (id: string, role: 'general' | 'dedicated', userId = 'alice'): RunnerScopeRecord => ({
    id,
    role,
    userId,
  });

  test('general runner serves a project without override', () => {
    expect(evaluateRunnerAccess(r('laptop', 'general'), policy())).toBe(true);
  });

  test('dedicated runner never serves an unrelated project', () => {
    expect(evaluateRunnerAccess(r('rx', 'dedicated'), policy())).toBe(false);
  });

  test('override pins the project to its dedicated runner', () => {
    const p = policy({ dedicatedRunnerId: 'rx' });
    expect(evaluateRunnerAccess(r('rx', 'dedicated'), p)).toBe(true);
    expect(evaluateRunnerAccess(r('laptop', 'general'), p)).toBe(false);
    expect(evaluateRunnerAccess(r('ry', 'dedicated'), p)).toBe(false);
  });

  test('explicit grant opens access for any runner', () => {
    const p = policy({ dedicatedRunnerId: 'rx', grantedRunnerIds: ['laptop', 'ry'] });
    expect(evaluateRunnerAccess(r('laptop', 'general'), p)).toBe(true);
    expect(evaluateRunnerAccess(r('ry', 'dedicated'), p)).toBe(true);
  });

  test("a collaborator's general runner is unaffected by the owner's override", () => {
    const p = policy({ dedicatedRunnerId: 'rx' });
    expect(evaluateRunnerAccess(r('bob-laptop', 'general', 'bob'), p)).toBe(true);
  });
});

describe('runner scope persistence', () => {
  test('dedicated override, grant and revoke', async () => {
    seedProject(testDb.db, { id: 'px', userId: 'alice' });
    seedProject(testDb.db, { id: 'py', userId: 'alice' });
    runner('laptop', 'alice');
    runner('rx', 'alice', 'dedicated');
    runner('ry', 'alice', 'dedicated');

    // Defaults: general serves both, dedicated serves nothing.
    expect(await canRunnerAccessProject('laptop', 'px')).toBe(true);
    expect(await canRunnerAccessProject('rx', 'px')).toBe(false);
    expect(await pinnedRunnerIdsForProject('px', 'alice')).toBeNull();

    const pinned = await setProjectDedicatedRunner('px', 'alice', 'rx');
    expect(pinned).toEqual({ ok: true, revokedRunnerIds: ['laptop'] });
    expect(await canRunnerAccessProject('rx', 'px')).toBe(true);
    expect(await canRunnerAccessProject('laptop', 'px')).toBe(false);
    expect(await canRunnerAccessProject('rx', 'py')).toBe(false);
    expect(await canRunnerAccessProject('ry', 'px')).toBe(false);
    expect(await pinnedRunnerIdsForProject('px', 'alice')).toEqual(['rx']);

    expect(await grantProjectRunner('px', 'alice', 'ry')).toBe(true);
    expect(await canRunnerAccessProject('ry', 'px')).toBe(true);
    expect(await pinnedRunnerIdsForProject('px', 'alice')).toEqual(['rx', 'ry']);

    expect(await revokeProjectRunner('px', 'alice', 'ry')).toEqual({ ok: true, lostAccess: true });
    expect(await canRunnerAccessProject('ry', 'px')).toBe(false);

    // Clearing the override gives the project back to the general runner.
    const cleared = await setProjectDedicatedRunner('px', 'alice', null);
    expect(cleared).toEqual({ ok: true, revokedRunnerIds: ['rx'] });
    expect(await canRunnerAccessProject('laptop', 'px')).toBe(true);
  });

  test("cannot pin or grant another user's runner, or someone else's project", async () => {
    seedProject(testDb.db, { id: 'px', userId: 'alice' });
    runner('bob-r', 'bob', 'dedicated');
    runner('rx', 'alice', 'dedicated');
    expect((await setProjectDedicatedRunner('px', 'alice', 'bob-r')).ok).toBe(false);
    expect(await grantProjectRunner('px', 'alice', 'bob-r')).toBe(false);
    expect((await setProjectDedicatedRunner('px', 'bob', 'rx')).ok).toBe(false);
  });

  test('projectless work only on general runners', async () => {
    runner('laptop', 'alice');
    runner('rx', 'alice', 'dedicated');
    expect(await canRunnerServeProjectless('laptop')).toBe(true);
    expect(await canRunnerServeProjectless('rx')).toBe(false);
    expect(await canRunnerServeProjectless('missing')).toBe(false);
  });

  test('general runner designation orders candidates and is user-scoped', async () => {
    runner('a', 'alice');
    runner('b', 'alice');
    runner('d', 'alice', 'dedicated');
    runner('bob-r', 'bob');
    expect(await setGeneralRunner('alice', 'b')).toBe(true);
    expect(await generalRunnerIdsForUser('alice')).toEqual(['b', 'a']);
    expect(await setGeneralRunner('alice', 'bob-r')).toBe(false);

    // Designating a dedicated runner as general switches its role.
    expect(await setGeneralRunner('alice', 'd')).toBe(true);
    expect((await generalRunnerIdsForUser('alice'))[0]).toBe('d');
    await setRunnerRole('d', 'dedicated');
    expect(await generalRunnerIdsForUser('alice')).not.toContain('d');
  });
});
