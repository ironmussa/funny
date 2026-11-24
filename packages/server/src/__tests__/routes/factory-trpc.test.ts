/**
 * The `factory` tRPC procedures (change issue-factory; the REST `/api/factory`
 * routes were retired): the caller's own settings per project, the role a save
 * needs, input validation and the run list.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { FactoryRunState } from '../../services/factory/factory-runs.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedProjectMember } from '../helpers/test-db.js';

describe('factory over tRPC', () => {
  let t: TestApp;

  const headersFor = (userId: string) => ({
    'X-Test-User-Id': userId,
    'Content-Type': 'application/json',
  });

  const query = async (userId: string, path: string, input: unknown) => {
    const qs = `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await t.app.request(`/api/trpc/factory.${path}${qs}`, {
      headers: headersFor(userId),
    });
    return { status: res.status, body: (await res.json()).result?.data };
  };

  const save = async (userId: string, input: unknown) => {
    const res = await t.app.request('/api/trpc/factory.save', {
      method: 'POST',
      headers: headersFor(userId),
      body: JSON.stringify(input),
    });
    return { status: res.status, body: (await res.json()).result?.data };
  };

  beforeAll(async () => {
    t = await createTestApp({ userId: 'alice' });
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db, { id: 'p1', userId: 'alice', path: '/repo-a' });
    seedProject(t.db, { id: 'bob-project', userId: 'bob', path: '/repo-b' });
  });

  test('settings are null until saved, then read back', async () => {
    expect(await query('alice', 'settings', { projectId: 'p1' })).toEqual({
      status: 200,
      body: null,
    });

    const saved = await save('alice', {
      projectId: 'p1',
      enabled: true,
      label: 'ready',
      maxConcurrent: 3,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, label: 'ready', maxConcurrent: 3 });

    const read = await query('alice', 'settings', { projectId: 'p1' });
    expect(read.body).toMatchObject({ enabled: true, label: 'ready' });
  });

  test('runs is empty until a factory exists, then lists none', async () => {
    expect((await query('alice', 'runs', { projectId: 'p1' })).body).toEqual([]);
    await save('alice', { projectId: 'p1', enabled: true });
    expect((await query('alice', 'runs', { projectId: 'p1' })).body).toEqual([]);
  });

  test('a contributor may save; a viewer may read but not save; an outsider gets 404', async () => {
    seedProjectMember(t.db, { projectId: 'bob-project', userId: 'alice', role: 'member' });
    seedProjectMember(t.db, { projectId: 'bob-project', userId: 'vic', role: 'viewer' });

    expect((await save('alice', { projectId: 'bob-project', enabled: true })).status).toBe(200);
    expect((await query('vic', 'settings', { projectId: 'bob-project' })).status).toBe(200);
    expect((await save('vic', { projectId: 'bob-project', enabled: true })).status).toBe(403);
    expect((await save('carol', { projectId: 'p1', enabled: true })).status).toBe(404);
    expect((await query('carol', 'settings', { projectId: 'p1' })).status).toBe(404);
  });

  test('refuses a malformed input, a path-like flow name and a label with a comma', async () => {
    expect((await save('alice', { projectId: 'p1' })).status).toBe(400);
    expect(
      (await save('alice', { projectId: 'p1', enabled: true, maxConcurrent: 99 })).status,
    ).toBe(400);
    expect((await save('alice', { projectId: 'p1', enabled: true, label: '' })).status).toBe(400);
    expect(
      (await save('alice', { projectId: 'p1', enabled: true, flowName: '../secrets' })).status,
    ).toBe(400);
    expect((await save('alice', { projectId: 'p1', enabled: true, label: 'a,b' })).status).toBe(
      400,
    );
  });

  test('the retired REST path answers 404 instead of reaching a runner', async () => {
    const res = await t.app.request('/api/factory/projects/p1', { headers: headersFor('alice') });
    expect(res.status).toBe(404);
  });

  const mutate = async (userId: string, path: string, input: unknown) => {
    const res = await t.app.request(`/api/trpc/factory.${path}`, {
      method: 'POST',
      headers: headersFor(userId),
      body: JSON.stringify(input),
    });
    const json = await res.json();
    return { status: res.status, body: json.result?.data, message: json.error?.message };
  };

  async function seededRun(state: FactoryRunState) {
    await save('alice', { projectId: 'p1', enabled: false });
    const { createFactorySettingsService } =
      await import('../../services/factory/factory-settings.js');
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const factoryId = (
      await createFactorySettingsService().factoryId('alice', 'p1')
    )._unsafeUnwrap()!;
    return (
      await createFactoryRunsRepository().start({ factoryId, issueNumber: 7, state })
    )._unsafeUnwrap();
  }

  test('the owner stops a run in flight and retries a failed one', async () => {
    const running = await seededRun('working');
    const stopped = await mutate('alice', 'stopRun', { projectId: 'p1', runId: running.id });
    expect(stopped).toMatchObject({ status: 200, body: { state: 'stopped' } });
    // A stopped run has ended: neither stop nor retry applies.
    expect((await mutate('alice', 'stopRun', { projectId: 'p1', runId: running.id })).status).toBe(
      409,
    );
    expect((await mutate('alice', 'retryRun', { projectId: 'p1', runId: running.id })).status).toBe(
      409,
    );

    const failed = await seededRun('failed');
    const retried = await mutate('alice', 'retryRun', { projectId: 'p1', runId: failed.id });
    expect(retried).toMatchObject({ status: 200, body: { state: 'queued' } });
  });

  test('approving a held high-risk merge retries the run, and each control shows in activities', async () => {
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const { activities } = await import('../../db/schema.js');
    // Earlier tests' controls recorded activities too: only this test's count.
    const since = new Date().toISOString();
    const held = await seededRun('waiting_human');
    await createFactoryRunsRepository().update(held.id, {
      failureReason: 'high risk',
      risk: {
        headSha: 'c2b585c51b2e',
        level: 'high',
        reasons: ['touches a sensitive path: packages/server/src/db/migrate.ts (**/migrate.ts)'],
        changedLines: 10,
        paths: ['packages/server/src/db/migrate.ts'],
      },
    });

    // A viewer may not approve; the owner does, once.
    seedProjectMember(t.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
    expect((await mutate('vic', 'approveMerge', { projectId: 'p1', runId: held.id })).status).toBe(
      403,
    );
    const approved = await mutate('alice', 'approveMerge', { projectId: 'p1', runId: held.id });
    expect(approved).toMatchObject({
      status: 200,
      body: { state: 'queued', mergeApproval: { sha: 'c2b585c51b2e', userId: 'alice' } },
    });
    // The run moved on: approving again is refused, and that is recorded too.
    expect(
      (await mutate('alice', 'approveMerge', { projectId: 'p1', runId: held.id })).status,
    ).toBe(409);
    await mutate('alice', 'stopRun', { projectId: 'p1', runId: held.id });

    // Recording does not hold up the answer: wait for the rows.
    let rows: Array<typeof activities.$inferSelect> = [];
    for (let i = 0; i < 50 && rows.length < 3; i++) {
      rows = (await t.db.select().from(activities)).filter((row) => row.startedAt >= since);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const byKind = rows
      .map((row) => [row.kind, row.status, row.title] as const)
      .sort(([a, sa], [b, sb]) => `${a}${sa}`.localeCompare(`${b}${sb}`));
    expect(byKind).toEqual([
      ['factory.approve-merge', 'failed', 'Approve merging #7, a high-risk change'],
      ['factory.approve-merge', 'succeeded', 'Approved merging #7, a high-risk change (c2b585c)'],
      ['factory.stop', 'succeeded', 'Stopped the factory run for #7'],
    ]);
    expect(rows.every((row) => row.userId === 'alice' && row.origin === 'user')).toBe(true);
  });

  test("another user's run is not found, and a viewer cannot control runs", async () => {
    const run = await seededRun('working');
    expect((await mutate('bob', 'stopRun', { projectId: 'p1', runId: run.id })).status).toBe(404);
    seedProjectMember(t.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
    expect((await mutate('vic', 'stopRun', { projectId: 'p1', runId: run.id })).status).toBe(403);
    expect((await mutate('alice', 'stopRun', { projectId: 'p1', runId: 'nope' })).status).toBe(404);
  });
  test('activeRuns lists the caller own runs with threads that have not ended or recently failed', async () => {
    const { createFactorySettingsService } =
      await import('../../services/factory/factory-settings.js');
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const repo = createFactoryRunsRepository();
    const factoryOf = async (userId: string, projectId: string) => {
      await save(userId, { projectId, enabled: false });
      return (await createFactorySettingsService().factoryId(userId, projectId))._unsafeUnwrap()!;
    };
    const alice = await factoryOf('alice', 'p1');
    const bob = await factoryOf('bob', 'bob-project');
    const seed = async (factoryId: string, issueNumber: number, state: FactoryRunState) =>
      (await repo.start({ factoryId, issueNumber, state }))._unsafeUnwrap();

    const ci = await seed(alice, 1, 'waiting_ci');
    const parked = await seed(alice, 2, 'waiting_human');
    await seed(alice, 3, 'merged');
    const failed = await seed(alice, 4, 'failed');
    const oldFailure = await seed(alice, 7, 'failed');
    const { db } = await import('../../db/index.js');
    const { factoryRuns } = await import('../../db/schema.js');
    const { eq } = await import('drizzle-orm');
    // A failed run shows on its thread for two weeks after it failed.
    const failedAt = async (id: string, completedAt: string) =>
      db.update(factoryRuns).set({ completedAt }).where(eq(factoryRuns.id, id));
    await failedAt(failed.id, new Date().toISOString());
    await failedAt(oldFailure.id, '2026-01-01T00:00:00.000Z');
    await seed(alice, 5, 'requested');
    await seed(bob, 6, 'working');

    const listed = await query('alice', 'activeRuns', undefined);
    expect(listed.status).toBe(200);
    expect(listed.body.map((run: { id: string }) => run.id).sort()).toEqual(
      [ci.id, parked.id, failed.id].sort(),
    );
    expect((await query('carol', 'activeRuns', undefined)).body).toEqual([]);
  });

  test('queueRuns lists the caller own unended runs and the recently ended ones, with their project', async () => {
    const { createFactorySettingsService } =
      await import('../../services/factory/factory-settings.js');
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const repo = createFactoryRunsRepository();
    const factoryOf = async (userId: string, projectId: string) => {
      await save(userId, { projectId, enabled: false });
      return (await createFactorySettingsService().factoryId(userId, projectId))._unsafeUnwrap()!;
    };
    const alice = await factoryOf('alice', 'p1');
    const bob = await factoryOf('bob', 'bob-project');
    const seed = async (factoryId: string, issueNumber: number, state: FactoryRunState) =>
      (await repo.start({ factoryId, issueNumber, state }))._unsafeUnwrap();

    const queued = await seed(alice, 1, 'requested');
    const working = await seed(alice, 2, 'working');
    const parked = await seed(alice, 3, 'waiting_human');
    const merged = await seed(alice, 4, 'merged');
    const stopped = await seed(alice, 5, 'stopped');
    const failed = await seed(alice, 7, 'failed');
    const oldMerge = await seed(alice, 8, 'merged');
    await seed(bob, 6, 'requested');
    const { db } = await import('../../db/index.js');
    const { factoryRuns } = await import('../../db/schema.js');
    const { eq } = await import('drizzle-orm');
    // An ended run (merged, failed or stopped) shows for two weeks after it ended.
    const endedAt = async (id: string, completedAt: string) =>
      db.update(factoryRuns).set({ completedAt }).where(eq(factoryRuns.id, id));
    const recently = new Date().toISOString();
    for (const run of [merged, stopped, failed]) await endedAt(run.id, recently);
    await endedAt(oldMerge.id, '2026-01-01T00:00:00.000Z');

    const listed = await query('alice', 'queueRuns', undefined);
    expect(listed.status).toBe(200);
    expect(listed.body.map((run: { id: string }) => run.id).sort()).toEqual(
      [queued.id, working.id, parked.id, merged.id, stopped.id, failed.id].sort(),
    );
    expect(listed.body.every((run: { projectId: string }) => run.projectId === 'p1')).toBe(true);
    expect((await query('carol', 'queueRuns', undefined)).body).toEqual([]);
  });

  test('the mode is saved and read back, a new factory is manual, and a bad mode is refused', async () => {
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      mode: 'manual',
    });
    expect(
      (await save('alice', { projectId: 'p1', enabled: false, mode: 'automatic' })).body,
    ).toMatchObject({ mode: 'automatic', enabled: false });
    // Omitting the mode keeps it.
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      mode: 'automatic',
    });
    expect((await save('alice', { projectId: 'p1', enabled: true, mode: 'later' })).status).toBe(
      400,
    );
  });

  test('a run in review or merging is listed with its verdicts and risk', async () => {
    const { createFactoryRunsRepository, withReviewVerdict } =
      await import('../../services/factory/factory-runs.js');
    const runs = createFactoryRunsRepository();
    const run = await seededRun('waiting_ci');
    const sha = 'c'.repeat(40);
    const verdict = {
      sha,
      verdict: 'fail' as const,
      findings: [{ severity: 'high' as const, title: 'Missing null check' }],
      threadId: 'th-review',
      reviewedAt: '2026-11-22T10:00:00.000Z',
    };

    expect(
      (
        await runs.enterStage(run.id, 'review', {
          reviews: withReviewVerdict([], verdict),
          risk: { headSha: sha, level: 'high', reasons: ['touches .github/'] },
        })
      )._unsafeUnwrap(),
    ).toBe(true);
    const reviewing = (await query('alice', 'runs', { projectId: 'p1' })).body;
    expect(reviewing).toMatchObject([
      {
        id: run.id,
        state: 'reviewing',
        reviews: [verdict],
        risk: { headSha: sha, level: 'high', reasons: ['touches .github/'] },
      },
    ]);

    expect((await runs.enterStage(run.id, 'merge'))._unsafeUnwrap()).toBe(true);
    const merging = (await query('alice', 'runs', { projectId: 'p1' })).body;
    expect(merging).toMatchObject([{ state: 'merging', reviews: [verdict] }]);
    // Waiting for the merge slot holds one of the factory's slots.
    expect((await runs.countActive(run.factoryId))._unsafeUnwrap()).toBe(1);
  });

  test('a run enters review or merge only with a pull request and a flow driving it', async () => {
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const runs = createFactoryRunsRepository();
    for (const state of ['working', 'queued', 'requested', 'waiting_human', 'stopped'] as const) {
      t.cleanup();
      seedProject(t.db, { id: 'p1', userId: 'alice', path: '/repo-a' });
      const run = await seededRun(state);
      expect((await runs.enterStage(run.id, 'review'))._unsafeUnwrap()).toBe(false);
      expect((await runs.enterStage(run.id, 'merge'))._unsafeUnwrap()).toBe(false);
      expect((await runs.get(run.id))._unsafeUnwrap()?.state).toBe(state);
    }
  });

  test('a new verdict of a commit replaces the old one', async () => {
    const { withReviewVerdict } = await import('../../services/factory/factory-runs.js');
    const at = '2026-11-22T10:00:00.000Z';
    const first = { sha: 'a'.repeat(40), verdict: 'fail' as const, findings: [], reviewedAt: at };
    const other = { sha: 'b'.repeat(40), verdict: 'pass' as const, findings: [], reviewedAt: at };
    const again = { ...first, verdict: 'pass' as const };
    expect(withReviewVerdict(withReviewVerdict([first], other), again)).toEqual([other, again]);
  });

  test('the merge policy, sensitive paths and stage limits are saved and read back', async () => {
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      autoMerge: 'low_risk',
      sensitivePaths: [],
      stageLimits: {},
    });
    const saved = await save('alice', {
      projectId: 'p1',
      enabled: true,
      autoMerge: 'all',
      sensitivePaths: ['billing/**'],
      stageLimits: { review: 1, implement: 3 },
    });
    expect(saved.body).toMatchObject({
      autoMerge: 'all',
      sensitivePaths: ['billing/**'],
      stageLimits: { review: 1, implement: 3 },
    });
    // Omitted fields keep their values.
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      autoMerge: 'all',
      sensitivePaths: ['billing/**'],
      stageLimits: { review: 1, implement: 3 },
    });
    expect((await save('alice', { projectId: 'p1', enabled: true, autoMerge: 'yes' })).status).toBe(
      400,
    );
  });

  // openspec factory-flow-step-options, 4.1.
  test('step overrides are saved and read back; a permission mode or a bad pair is refused', async () => {
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      stepOverrides: {},
    });
    const overrides = {
      'ci.before_retry': { model: 'haiku' },
      review: { provider: 'codex', effort: 'high' },
    };
    const saved = await save('alice', { projectId: 'p1', enabled: true, stepOverrides: overrides });
    expect(saved.body).toMatchObject({ stepOverrides: overrides });
    // Omitted: kept.
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      stepOverrides: overrides,
    });
    // The permission mode and tool lists stay in the reviewed flow file.
    const withMode = await save('alice', {
      projectId: 'p1',
      enabled: true,
      stepOverrides: { implement: { permissionMode: 'auto' } },
    });
    expect(withMode.status).toBe(400);
    const withTools = await save('alice', {
      projectId: 'p1',
      enabled: true,
      stepOverrides: { implement: { disallowedTools: [] } },
    });
    expect(withTools.status).toBe(400);
    // A model the provider does not have, or an unknown provider.
    const badPair = await save('alice', {
      projectId: 'p1',
      enabled: true,
      stepOverrides: { implement: { provider: 'codex', model: 'opus' } },
    });
    expect(badPair.status).toBe(400);
    const unknown = await save('alice', {
      projectId: 'p1',
      enabled: true,
      stepOverrides: { implement: { provider: 'nope' } },
    });
    expect(unknown.status).toBe(400);
    expect((await query('alice', 'settings', { projectId: 'p1' })).body).toMatchObject({
      stepOverrides: overrides,
    });
  });

  test('Validate flow reads with view and answers a summary; an outsider gets 404', async () => {
    seedProjectMember(t.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
    const input = { projectId: 'p1', flowName: 'issue-to-pr' };
    const answer = await query('vic', 'validateFlow', input);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, name: 'issue-to-pr', source: 'built-in' });
    expect((await query('bob', 'validateFlow', input)).status).toBe(404);
  });

  test('a viewer cannot change step overrides', async () => {
    seedProjectMember(t.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
    const refused = await save('vic', {
      projectId: 'p1',
      enabled: true,
      stepOverrides: { implement: { model: 'haiku' } },
    });
    expect(refused.status).toBe(403);
  });

  // openspec factory-integration 5.2: stacked pull requests.
  test('an in-flight blocker is waited for unless the factory stacks', async () => {
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      dependencies: 'wait',
    });
    const saved = await save('alice', { projectId: 'p1', enabled: true, dependencies: 'stack' });
    expect(saved.body).toMatchObject({ dependencies: 'stack' });
    expect(
      (await save('alice', { projectId: 'p1', enabled: true, dependencies: 'merge' })).status,
    ).toBe(400);
  });

  // openspec factory-integration 6.1: how the repository merges, and why.
  test('readiness says how the repository merges; without a running factory, one at a time', async () => {
    await save('alice', { projectId: 'p1', enabled: true });
    const answer = await query('alice', 'readiness', { projectId: 'p1' });
    expect(answer).toMatchObject({
      status: 200,
      body: { mode: 'serial', reasons: [expect.stringContaining('not running on this server')] },
    });
  });

  // openspec factory-integration 4.6: the merge queue's batches.
  test('the batch size and wait default to 5 and 60 s, are saved, and are bounded', async () => {
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      batch: { size: 5, waitSeconds: 60 },
    });
    const saved = await save('alice', {
      projectId: 'p1',
      enabled: true,
      batch: { size: 1, waitSeconds: 0 },
    });
    expect(saved.body).toMatchObject({ batch: { size: 1, waitSeconds: 0 } });
    // Omitted, it keeps its value.
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      batch: { size: 1, waitSeconds: 0 },
    });
    for (const batch of [
      { size: 0, waitSeconds: 60 },
      { size: 11, waitSeconds: 60 },
      { size: 5, waitSeconds: 601 },
    ]) {
      expect((await save('alice', { projectId: 'p1', enabled: true, batch })).status).toBe(400);
    }
  });

  test('the merge limit cannot be raised', async () => {
    await save('alice', { projectId: 'p1', enabled: true, stageLimits: { review: 2 } });
    const refused = await save('alice', {
      projectId: 'p1',
      enabled: true,
      stageLimits: { merge: 2 },
    });
    expect(refused.status).toBe(400);
    expect((await query('alice', 'settings', { projectId: 'p1' })).body).toMatchObject({
      stageLimits: { review: 2 },
    });
  });

  // Change factory-agent-roles, phase 2: triage and its two transitions.
  test('a run triaging or waiting on its issue is listed with what triage decided', async () => {
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const runs = createFactoryRunsRepository();
    const run = await seededRun('triaging');
    expect((await query('alice', 'runs', { projectId: 'p1' })).body).toMatchObject([
      { id: run.id, state: 'triaging', triage: null },
    ]);

    const triage = {
      decision: 'needs_info' as const,
      at: '2026-11-22T10:00:00.000Z',
      threadId: 'th-triage',
      items: ['Which endpoint is slow?'],
    };
    await runs.update(run.id, { state: 'needs_info', triage });
    expect((await query('alice', 'runs', { projectId: 'p1' })).body).toMatchObject([
      { state: 'needs_info', triage },
    ]);
    // Parked on its issue: it holds no slot, and still holds its issue.
    expect((await runs.countActive(run.factoryId))._unsafeUnwrap()).toBe(0);
    expect((await runs.activeByIssue(run.factoryId, 7))._unsafeUnwrap()?.id).toBe(run.id);
    expect((await runs.needingInfo(run.factoryId))._unsafeUnwrap().map((r) => r.id)).toEqual([
      run.id,
    ]);
  });

  test('a needs_info run goes back in line to be triaged again, only from needs_info', async () => {
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const runs = createFactoryRunsRepository();
    const run = await seededRun('working');
    expect((await runs.retriage(run))._unsafeUnwrap()).toBe(false);

    const asked = { decision: 'needs_info' as const, at: '2026-11-22T10:00:00.000Z', items: ['?'] };
    await runs.update(run.id, { state: 'needs_info', triage: asked });
    const parked = (await runs.get(run.id))._unsafeUnwrap()!;
    expect((await runs.retriage(parked))._unsafeUnwrap()).toBe(true);
    const again = (await runs.get(run.id))._unsafeUnwrap()!;
    // In the queue without a slot; what was asked stays, marked as no longer the answer.
    expect(again).toMatchObject({
      state: 'requested',
      triage: { ...asked, superseded: true },
      completedAt: null,
    });
    expect((await runs.retriage(again))._unsafeUnwrap()).toBe(false);
  });

  test('a run whose paths overlap leaves its slot from triaging only, keeping its contract', async () => {
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const runs = createFactoryRunsRepository();
    const run = await seededRun('working');
    expect((await runs.holdForPaths(run.id, [12]))._unsafeUnwrap()).toBe(false);

    const triage = {
      decision: 'ready' as const,
      at: '2026-11-22T10:00:00.000Z',
      contract: {
        acceptanceCriteria: ['It works'],
        likelyPaths: ['src/db/migrate.ts'],
        riskHints: [],
      },
    };
    await runs.update(run.id, { state: 'triaging', triage });
    expect((await runs.holdForPaths(run.id, [12]))._unsafeUnwrap()).toBe(true);
    expect((await runs.get(run.id))._unsafeUnwrap()).toMatchObject({
      state: 'requested',
      triage,
      waitReason: { kind: 'paths-overlap', blockers: [12] },
    });
    expect((await runs.countActive(run.factoryId))._unsafeUnwrap()).toBe(0);
  });

  // Change factory-agent-roles, D10: the incident that pauses a factory.
  describe('incidents', () => {
    async function openIncident() {
      await save('alice', { projectId: 'p1', enabled: true });
      const { createFactorySettingsService } =
        await import('../../services/factory/factory-settings.js');
      const { createFactoryIncidentsRepository } =
        await import('../../services/factory/factory-incidents.js');
      const factoryId = (
        await createFactorySettingsService().factoryId('alice', 'p1')
      )._unsafeUnwrap()!;
      const incidents = createFactoryIncidentsRepository();
      const incident = (
        await incidents.open({
          repo: 'o/r',
          baseBranch: 'main',
          redSha: 'abc123',
          candidates: [
            {
              issueNumber: 12,
              prUrl: 'https://github.com/o/r/pull/112',
              mergedAt: '2026-11-22T11:00:00.000Z',
              userId: 'alice',
            },
          ],
          factoryId,
        })
      )._unsafeUnwrap()!;
      return { incidents, incident };
    }

    test('the settings carry the incident that pauses the factory, without the server bookkeeping', async () => {
      expect((await save('alice', { projectId: 'p1', enabled: true })).body.incident).toBeNull();
      const { incident } = await openIncident();
      const read = (await query('alice', 'settings', { projectId: 'p1' })).body;
      expect(read.incident).toMatchObject({
        id: incident.id,
        repo: 'o/r',
        baseBranch: 'main',
        state: 'open',
        result: null,
      });
      expect(read.incident).not.toHaveProperty('affectedFactories');
      expect(read.incident).not.toHaveProperty('sentinelThreadId');
      // A save answers with it too, so the panel keeps showing it.
      const saved = await save('alice', { projectId: 'p1', enabled: true, maxConcurrent: 3 });
      expect(saved.body.incident).toMatchObject({ id: incident.id });
    });

    test('a member closes it and the factory is no longer paused by it', async () => {
      const { incidents, incident } = await openIncident();
      const closed = await mutate('alice', 'closeIncident', { projectId: 'p1' });
      expect(closed).toMatchObject({ status: 200, body: { incident: null } });
      const stored = (await incidents.get(incident.id))._unsafeUnwrap()!;
      expect(stored).toMatchObject({ state: 'closed' });
      // Nothing left to close.
      expect((await mutate('alice', 'closeIncident', { projectId: 'p1' })).status).toBe(404);
    });

    test('closing needs steer, and another user cannot close it through their own project', async () => {
      await openIncident();
      seedProjectMember(t.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
      expect((await mutate('vic', 'closeIncident', { projectId: 'p1' })).status).toBe(403);
      expect((await mutate('carol', 'closeIncident', { projectId: 'p1' })).status).toBe(404);
      // Bob has his own factory, which this incident did not pause.
      await save('bob', { projectId: 'bob-project', enabled: true });
      expect((await mutate('bob', 'closeIncident', { projectId: 'bob-project' })).status).toBe(404);
      expect((await query('alice', 'settings', { projectId: 'p1' })).body.incident).not.toBeNull();
    });
  });

  test('a send needs a factory, a running one, and a usable input', async () => {
    const send = { projectId: 'p1', issueNumbers: [7], flowName: 'issue-to-merge' };
    expect((await mutate('alice', 'submitIssues', send)).status).toBe(404);

    await save('alice', { projectId: 'p1', enabled: false });
    const paused = await mutate('alice', 'submitIssues', send);
    expect(paused.status).toBe(409);
    expect(paused.message).toContain('paused');

    expect((await mutate('alice', 'submitIssues', { ...send, issueNumbers: [] })).status).toBe(400);
    expect((await mutate('alice', 'submitIssues', { ...send, flowName: '../x' })).status).toBe(400);
    expect((await query('alice', 'runs', { projectId: 'p1' })).body).toEqual([]);
  });

  test('a viewer may list flows but not send, clear or stop all', async () => {
    seedProjectMember(t.db, { projectId: 'bob-project', userId: 'vic', role: 'viewer' });
    const flows = await query('vic', 'flows', { projectId: 'bob-project' });
    expect(flows.body).toEqual([
      { name: 'issue-to-merge', source: 'built-in' },
      { name: 'issue-to-pr', source: 'built-in' },
    ]);
    const send = { projectId: 'bob-project', issueNumbers: [7], flowName: 'issue-to-merge' };
    expect((await mutate('vic', 'submitIssues', send)).status).toBe(403);
    expect((await mutate('vic', 'clearQueue', { projectId: 'bob-project' })).status).toBe(403);
    expect((await mutate('vic', 'stopAll', { projectId: 'bob-project' })).status).toBe(403);
  });

  test('clear queue and stop all act on the caller own factory', async () => {
    expect((await mutate('alice', 'clearQueue', { projectId: 'p1' })).status).toBe(404);
    await save('alice', { projectId: 'p1', enabled: true });
    expect((await mutate('alice', 'clearQueue', { projectId: 'p1' })).body).toEqual({
      cleared: 0,
      stopped: 0,
    });
    expect((await mutate('alice', 'stopAll', { projectId: 'p1' })).body).toEqual({
      cleared: 0,
      stopped: 0,
    });
  });
});
