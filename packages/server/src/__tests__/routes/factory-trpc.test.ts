/**
 * The `factory` tRPC procedures (change issue-factory; the REST `/api/factory`
 * routes were retired): the caller's own settings per project, the role a save
 * needs, input validation and the run list.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { errAsync, okAsync } from 'neverthrow';

import type { FactoryGithubPort } from '../../services/factory/factory-github.js';
import type { FactoryRunState } from '../../services/factory/factory-runs.js';
import { startFactoryWatcher, stopFactoryWatcher } from '../../services/factory/factory-watcher.js';
import { proofReadyFlowFiles, unusedRunnerPorts } from '../helpers/builders-services.js';
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

  const startProofReadyWatcher = (files: Record<string, string> = proofReadyFlowFiles()) => {
    const githubPartial: Partial<FactoryGithubPort> = {
      resolveRepo: async () => 'o/r',
      defaultBranch: () => okAsync('main'),
      defaultBranchHead: () => okAsync({ branch: 'main', sha: 'sha-base' }),
      readDefaultBranchFile: (_reader: unknown, path: string) => okAsync(files[path] ?? null),
      readFileAt: (_reader: unknown, path: string) => okAsync(files[path] ?? null),
      listDefaultBranchDir: () => okAsync([]),
      relabelIssue: () => okAsync(undefined),
      commentOnIssue: () => okAsync(undefined),
      getIssue: () => errAsync({ message: 'not found', status: 404 }),
      issueText: () => okAsync({ title: 'Issue', body: '', comments: [] }),
    };
    return startFactoryWatcher({
      // SAFETY: test stub only exercises flow validation reads on the watcher's GitHub port.
      github: githubPartial as FactoryGithubPort,
      ports: unusedRunnerPorts(),
      createPoll: () => ({ stop: () => {} }),
    });
  };

  beforeAll(async () => {
    t = await createTestApp({ userId: 'alice' });
  });

  beforeEach(async () => {
    t.cleanup();
    seedProject(t.db, { id: 'p1', userId: 'alice', path: '/repo-a' });
    seedProject(t.db, { id: 'bob-project', userId: 'bob', path: '/repo-b' });
    await startProofReadyWatcher();
  });

  afterEach(() => {
    stopFactoryWatcher();
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
    const approval = { projectId: 'p1', runId: held.id, expectedSha: 'c2b585c51b2e' };
    expect((await mutate('vic', 'approveMerge', approval)).status).toBe(403);
    // An approval that names no commit is not a valid request.
    expect(
      (await mutate('alice', 'approveMerge', { projectId: 'p1', runId: held.id })).status,
    ).toBe(400);
    const approved = await mutate('alice', 'approveMerge', approval);
    expect(approved).toMatchObject({
      status: 200,
      body: { state: 'queued', mergeApproval: { sha: 'c2b585c51b2e', userId: 'alice' } },
    });
    // The run moved on: approving again is refused, and that is recorded too.
    expect((await mutate('alice', 'approveMerge', approval)).status).toBe(409);
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

  async function heldRun() {
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const held = await seededRun('waiting_human');
    await createFactoryRunsRepository().update(held.id, {
      failureReason: 'high risk',
      risk: {
        headSha: 'c2b585c51b2e',
        level: 'high',
        reasons: ['touches a sensitive path'],
        changedLines: 10,
        paths: ['packages/server/src/db/migrate.ts'],
      },
    });
    return held;
  }

  // A member's statement, like an approval: it needs steer and their session.
  test('vetoing the lint class of a held run, and taking it back, records who did and retries it; a viewer may not', async () => {
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const held = await heldRun();
    await createFactoryRunsRepository().update(held.id, {
      triage: {
        decision: 'ready',
        at: '2026-11-25T00:00:00.000Z',
        contract: {
          acceptanceCriteria: ['no warnings'],
          likelyPaths: [],
          riskHints: [],
          lintCleanup: true,
          lintRules: ['eslint/max-lines'],
        },
      },
    });
    const veto = { projectId: 'p1', runId: held.id, lintCleanup: false };
    seedProjectMember(t.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
    expect((await mutate('vic', 'setLintCleanup', veto)).status).toBe(403);
    expect(
      (await mutate('alice', 'setLintCleanup', { projectId: 'p1', runId: held.id })).status,
    ).toBe(400);

    // The veto is stored; the run stays held, nothing to retry.
    expect(await mutate('alice', 'setLintCleanup', veto)).toMatchObject({
      status: 200,
      body: { state: 'waiting_human', riskWaiver: { kind: 'not-lint-cleanup', userId: 'alice' } },
    });
    // Taken back: back in flight, so the next classification reads triage's class.
    expect(await mutate('alice', 'setLintCleanup', { ...veto, lintCleanup: true })).toMatchObject({
      status: 200,
      body: { state: 'queued', riskWaiver: null },
    });
  });

  // The agent found nothing to change; the member agrees and clears the run.
  test('a run that ended with no change is marked as done by a member with steer, and only that run', async () => {
    const idle = await seededRun('no_change');
    const input = { projectId: 'p1', runId: idle.id };
    seedProjectMember(t.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
    expect((await mutate('vic', 'markRunDone', input)).status).toBe(403);

    expect(await mutate('alice', 'markRunDone', input)).toMatchObject({
      status: 200,
      body: { state: 'done' },
    });
    // It is done now: marking it again changes nothing and says so.
    expect((await mutate('alice', 'markRunDone', input)).status).toBe(409);

    // A run that failed, or that waits with unsaved work, is not "nothing to change".
    const failed = await seededRun('failed');
    expect(
      (await mutate('alice', 'markRunDone', { projectId: 'p1', runId: failed.id })).status,
    ).toBe(409);
  });

  test('triage classing a lint cleanup of neutral rules counts until a member says it is not one', async () => {
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const { lintCleanupSource } = await import('@funny/shared/contracts/factory');
    const run = await seededRun('working');
    const runs = createFactoryRunsRepository();
    await runs.update(run.id, {
      triage: {
        decision: 'ready',
        at: '2026-11-25T00:00:00.000Z',
        contract: {
          acceptanceCriteria: ['no warnings'],
          likelyPaths: [],
          riskHints: [],
          lintCleanup: true,
          lintRules: ['eslint/max-lines-per-function', 'max-lines'],
        },
      },
    });
    const proposed = (await runs.get(run.id))._unsafeUnwrap()!;
    expect(proposed.riskWaiver).toBeNull();
    expect(lintCleanupSource(proposed)).toBe('triage');

    // The member overrules triage: stored, so the proposal stops counting.
    const off = await mutate('alice', 'setLintCleanup', {
      projectId: 'p1',
      runId: run.id,
      lintCleanup: false,
    });
    expect(off).toMatchObject({
      status: 200,
      body: { riskWaiver: { kind: 'not-lint-cleanup', userId: 'alice' } },
    });
    expect(lintCleanupSource((await runs.get(run.id))._unsafeUnwrap()!)).toBeNull();

    // Taken back: the veto is gone and triage's class counts again.
    const back = await mutate('alice', 'setLintCleanup', {
      projectId: 'p1',
      runId: run.id,
      lintCleanup: true,
    });
    expect(back).toMatchObject({ status: 200, body: { riskWaiver: null } });
    expect(lintCleanupSource((await runs.get(run.id))._unsafeUnwrap()!)).toBe('triage');
  });

  test('a member cannot class a run as a lint cleanup that triage did not', async () => {
    const { createFactoryRunsRepository } = await import('../../services/factory/factory-runs.js');
    const { lintCleanupSource } = await import('@funny/shared/contracts/factory');
    const run = await seededRun('working');
    const runs = createFactoryRunsRepository();
    // Triage proposed it, but for a rule whose fix can change behavior.
    await runs.update(run.id, {
      triage: {
        decision: 'ready',
        at: '2026-11-25T00:00:00.000Z',
        contract: {
          acceptanceCriteria: ['no warnings'],
          likelyPaths: [],
          riskHints: [],
          lintCleanup: true,
          lintRules: ['anti-slop/no-unknown-parameters'],
        },
      },
    });
    expect(lintCleanupSource((await runs.get(run.id))._unsafeUnwrap()!)).toBeNull();
    const on = await mutate('alice', 'setLintCleanup', {
      projectId: 'p1',
      runId: run.id,
      lintCleanup: true,
    });
    expect(on).toMatchObject({ status: 200, body: { riskWaiver: null } });
    expect(lintCleanupSource((await runs.get(run.id))._unsafeUnwrap()!)).toBeNull();
  });

  test('a run that ended cannot be marked', async () => {
    const ended = await seededRun('merged');
    const marked = await mutate('alice', 'setLintCleanup', {
      projectId: 'p1',
      runId: ended.id,
      lintCleanup: true,
    });
    expect(marked.status).toBe(409);
  });

  const fromThread = { threadId: 't-ask', runnerId: 'laptop', runnerOwnerId: 'alice' };

  test("an agent's approval request is listed, declined by the owner only, and leaves the run held", async () => {
    const { factoryAgentTools } = await import('../../trpc/ports/factory.js');
    const { seedThread } = await import('../helpers/test-db.js');
    const held = await heldRun();
    seedThread(t.db, { id: 't-ask', projectId: 'p1', userId: 'alice' });

    const asked = (await factoryAgentTools.requestApproval(fromThread, held.id))._unsafeUnwrap();
    const listed = await query('alice', 'approvalRequests', { projectId: 'p1' });
    expect(listed.body).toEqual([
      expect.objectContaining({
        id: asked.requestId,
        runId: held.id,
        threadId: 't-ask',
        sha: 'c2b585c51b2e',
        state: 'pending',
      }),
    ]);
    // What a member sees carries no server bookkeeping.
    expect(listed.body[0]).not.toHaveProperty('factoryId');

    // An outsider sees no project; a viewer may not decline; another member has no such request.
    const decline = { projectId: 'p1', requestId: asked.requestId };
    expect((await query('carol', 'approvalRequests', { projectId: 'p1' })).status).toBe(404);
    seedProjectMember(t.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
    expect((await mutate('vic', 'declineApprovalRequest', decline)).status).toBe(403);
    seedProjectMember(t.db, { projectId: 'p1', userId: 'bob', role: 'member' });
    await save('bob', { projectId: 'p1', enabled: false });
    expect((await mutate('bob', 'declineApprovalRequest', decline)).status).toBe(404);
    expect((await query('bob', 'approvalRequests', { projectId: 'p1' })).body).toEqual([]);

    const declined = await mutate('alice', 'declineApprovalRequest', decline);
    expect(declined).toMatchObject({ status: 200, body: { state: 'declined' } });
    expect((await mutate('alice', 'declineApprovalRequest', decline)).status).toBe(409);
    const runs = (await query('alice', 'runs', { projectId: 'p1' })).body;
    expect(runs[0]).toMatchObject({ state: 'waiting_human', mergeApproval: null });
  });

  test('approving the run closes its pending request, and a request never approves', async () => {
    const { factoryAgentTools } = await import('../../trpc/ports/factory.js');
    const { seedThread } = await import('../helpers/test-db.js');
    const held = await heldRun();
    seedThread(t.db, { id: 't-ask', projectId: 'p1', userId: 'alice' });
    const asked = (await factoryAgentTools.requestApproval(fromThread, held.id))._unsafeUnwrap();

    // Asking changed nothing on the run.
    const before = (await query('alice', 'runs', { projectId: 'p1' })).body[0];
    expect(before).toMatchObject({ state: 'waiting_human', mergeApproval: null });

    const approved = await mutate('alice', 'approveMerge', {
      projectId: 'p1',
      runId: held.id,
      expectedSha: 'c2b585c51b2e',
    });
    expect(approved.status).toBe(200);
    const after = (await query('alice', 'approvalRequests', { projectId: 'p1' })).body;
    expect(after).toEqual([expect.objectContaining({ id: asked.requestId, state: 'approved' })]);
  });

  test("an agent's stop goes through the board's control and names the thread in the activity", async () => {
    const { factoryAgentTools } = await import('../../trpc/ports/factory.js');
    const { seedThread } = await import('../helpers/test-db.js');
    const { activities } = await import('../../db/schema.js');
    const since = new Date().toISOString();
    const running = await seededRun('working');
    seedThread(t.db, { id: 't-ask', projectId: 'p1', userId: 'alice' });

    const stopped = await factoryAgentTools.controlRun(fromThread, 'stop', running.id);
    expect(stopped._unsafeUnwrap()).toMatchObject({ id: running.id, state: 'stopped' });
    // The same refusal as the board for a run that has ended.
    const again = await factoryAgentTools.controlRun(fromThread, 'retry', running.id);
    expect(again._unsafeUnwrapErr().kind).toBe('conflict');

    let rows: Array<typeof activities.$inferSelect> = [];
    for (let i = 0; i < 50 && rows.length < 2; i++) {
      rows = (await t.db.select().from(activities)).filter((row) => row.startedAt >= since);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stop = rows.find((row) => row.kind === 'factory.stop');
    expect(stop).toMatchObject({
      userId: 'alice',
      threadId: 't-ask',
      origin: 'implicit',
      title: 'Stopped the factory run for #7 (asked by an agent)',
    });
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

  test('the size gate starts off, and turning it on keeps the line limit', async () => {
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      sizeGateEnabled: false,
      maxLowRiskLines: 400,
    });
    const on = await save('alice', {
      projectId: 'p1',
      enabled: true,
      sizeGateEnabled: true,
      maxLowRiskLines: 600,
    });
    expect(on.body).toMatchObject({ sizeGateEnabled: true, maxLowRiskLines: 600 });
    // Omitted, it keeps its value; turned off, the limit is kept for next time.
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      sizeGateEnabled: true,
    });
    expect(
      (await save('alice', { projectId: 'p1', enabled: true, sizeGateEnabled: false })).body,
    ).toMatchObject({ sizeGateEnabled: false, maxLowRiskLines: 600 });
  });

  test('the size limit and the globs left out of the size are saved and read back', async () => {
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      maxLowRiskLines: 400,
      sizeIgnoredPaths: [],
    });
    const saved = await save('alice', {
      projectId: 'p1',
      enabled: true,
      maxLowRiskLines: 800,
      sizeIgnoredPaths: ['**/generated/**'],
    });
    expect(saved.body).toMatchObject({
      maxLowRiskLines: 800,
      sizeIgnoredPaths: ['**/generated/**'],
    });
    // Omitted fields keep their values.
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      maxLowRiskLines: 800,
      sizeIgnoredPaths: ['**/generated/**'],
    });
    for (const maxLowRiskLines of [0, 9, 100_001, 12.5]) {
      expect(
        (await save('alice', { projectId: 'p1', enabled: true, maxLowRiskLines })).status,
      ).toBe(400);
    }
  });

  // openspec factory-approval-survives-integration, 4.2.
  test('the adjustment a merge approval follows is off by default, saved within its range, and needs steer', async () => {
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      approvalAdjustMaxLines: 0,
    });
    const saved = await save('alice', {
      projectId: 'p1',
      enabled: true,
      approvalAdjustMaxLines: 50,
    });
    expect(saved.body).toMatchObject({ approvalAdjustMaxLines: 50 });
    // Omitted, it keeps its value; 0 turns it off again.
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      approvalAdjustMaxLines: 50,
    });
    for (const approvalAdjustMaxLines of [-1, 201, 12.5]) {
      expect(
        (await save('alice', { projectId: 'p1', enabled: true, approvalAdjustMaxLines })).status,
      ).toBe(400);
    }
    // A viewer of the project may not set it.
    seedProjectMember(t.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
    expect(
      (await save('vic', { projectId: 'p1', enabled: true, approvalAdjustMaxLines: 10 })).status,
    ).toBe(403);
    expect(
      (await save('alice', { projectId: 'p1', enabled: true, approvalAdjustMaxLines: 0 })).body,
    ).toMatchObject({ approvalAdjustMaxLines: 0 });
  });

  // openspec factory-merge-fewer-bounces, D6.
  test('keeping the paths of a run that waits for an approval is off by default and saved', async () => {
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      holdPathsAwaitingApproval: false,
    });
    const on = { projectId: 'p1', enabled: true, holdPathsAwaitingApproval: true };
    expect((await save('alice', on)).body).toMatchObject({ holdPathsAwaitingApproval: true });
    // Omitted, it keeps its value; false turns it off again.
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      holdPathsAwaitingApproval: true,
    });
    expect((await save('alice', { ...on, holdPathsAwaitingApproval: false })).body).toMatchObject({
      holdPathsAwaitingApproval: false,
    });
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
    expect(answer.body).toMatchObject({
      ok: true,
      name: 'issue-to-pr',
      source: 'built-in',
      proofReady: true,
    });
    expect((await query('bob', 'validateFlow', input)).status).toBe(404);
  });

  test('enabling refuses with 409 when flow lacks proof rules and 503 when GitHub cannot be checked', async () => {
    stopFactoryWatcher();
    await startProofReadyWatcher({});
    const notReady = await mutate('alice', 'save', { projectId: 'p1', enabled: true });
    expect(notReady.status).toBe(409);
    expect(notReady.message).toContain('no regression proof rules');

    stopFactoryWatcher();
    const notChecked = await mutate('alice', 'save', { projectId: 'p1', enabled: true });
    expect(notChecked.status).toBe(503);
    expect(notChecked.message).toContain('could not be checked');
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

  test("the factory merges into the repository's default branch unless it names another", async () => {
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      baseBranch: '',
    });
    const saved = await save('alice', { projectId: 'p1', enabled: true, baseBranch: 'develop' });
    expect(saved.body).toMatchObject({ baseBranch: 'develop' });
    const { factoryBaseBranchOf } = await import('../../services/factory/factory-settings.js');
    expect(await factoryBaseBranchOf('alice', 'p1')).toBe('develop');
    // Saving something else keeps it; an empty name goes back to the default.
    expect(
      (await save('alice', { projectId: 'p1', enabled: true, maxConcurrent: 3 })).body,
    ).toMatchObject({ baseBranch: 'develop' });
    expect(
      (await save('alice', { projectId: 'p1', enabled: true, baseBranch: '' })).body,
    ).toMatchObject({ baseBranch: '' });
    expect(await factoryBaseBranchOf('alice', 'p1')).toBeNull();
    for (const bad of ['-x', 'a..b', 'has space', 'feat/', '.hidden']) {
      expect(
        (await save('alice', { projectId: 'p1', enabled: true, baseBranch: bad })).status,
      ).toBe(400);
    }
  });

  test('a too-large issue is commented unless the factory splits it', async () => {
    expect((await save('alice', { projectId: 'p1', enabled: true })).body).toMatchObject({
      tooBig: 'ask',
    });
    const saved = await save('alice', { projectId: 'p1', enabled: true, tooBig: 'split' });
    expect(saved.body).toMatchObject({ tooBig: 'split' });
    // Saving something else keeps it.
    expect(
      (await save('alice', { projectId: 'p1', enabled: true, maxConcurrent: 3 })).body,
    ).toMatchObject({ tooBig: 'split' });
    expect((await save('alice', { projectId: 'p1', enabled: true, tooBig: 'always' })).status).toBe(
      400,
    );
  });

  // openspec factory-integration 6.1: how the repository merges, and why.
  test('readiness says how the repository merges; without a running factory, one at a time', async () => {
    await save('alice', { projectId: 'p1', enabled: true });
    stopFactoryWatcher();
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
    await runs.updateInFlight(run.id, { state: 'needs_info', triage });
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
    const run = await seededRun('triaging');
    expect((await runs.retriage(run))._unsafeUnwrap()).toBe(false);

    const asked = { decision: 'needs_info' as const, at: '2026-11-22T10:00:00.000Z', items: ['?'] };
    await runs.updateInFlight(run.id, { state: 'needs_info', triage: asked });
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
    const run = await seededRun('queued');
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
    await runs.updateInFlight(run.id, { state: 'triaging', triage });
    // The contract is stored marked as held in the same write as the move.
    const held = { ...triage, heldForPaths: true };
    expect((await runs.holdForPaths(run.id, [12], held))._unsafeUnwrap()).toBe(true);
    expect((await runs.get(run.id))._unsafeUnwrap()).toMatchObject({
      state: 'requested',
      triage: held,
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

  describe('triggers and runs without an issue (change flow-triggers)', () => {
    const nightly = {
      projectId: 'p1',
      name: 'Nightly audit',
      schedule: '0 3 * * *',
      flowName: 'issue-to-pr',
    };

    test('a trigger needs a factory, a valid schedule and a flow that needs no issue', async () => {
      expect((await mutate('alice', 'saveTrigger', nightly)).status).toBe(404);
      expect((await query('alice', 'triggers', { projectId: 'p1' })).body).toEqual([]);

      await save('alice', { projectId: 'p1', enabled: true });
      const badSchedule = await mutate('alice', 'saveTrigger', { ...nightly, schedule: 'nightly' });
      expect(badSchedule.status).toBe(400);
      expect(badSchedule.message).toContain('Invalid schedule');

      const issueFlow = await mutate('alice', 'saveTrigger', nightly);
      expect(issueFlow.status).toBe(400);
      expect(issueFlow.message).toContain('issue_number');

      const badInput = await mutate('alice', 'saveTrigger', {
        ...nightly,
        inputs: { 'Bad-Name': 'x' },
      });
      expect(badInput.status).toBe(400);
      expect((await query('alice', 'triggers', { projectId: 'p1' })).body).toEqual([]);
    });

    test("a viewer reads triggers and a flow's inputs but cannot save, remove or start", async () => {
      seedProjectMember(t.db, { projectId: 'bob-project', userId: 'vic', role: 'viewer' });
      const at = { projectId: 'bob-project' };

      expect((await query('vic', 'triggers', at)).status).toBe(200);
      const flow = await query('vic', 'issuelessFlow', { ...at, flowName: 'issue-to-pr' });
      expect(flow.status).toBe(200);
      expect(flow.body.inputs.map((input: { name: string }) => input.name)).toContain(
        'issue_number',
      );

      expect((await mutate('vic', 'saveTrigger', { ...nightly, ...at })).status).toBe(403);
      expect((await mutate('vic', 'removeTrigger', { ...at, triggerId: 'x' })).status).toBe(403);
      expect((await mutate('vic', 'runFlow', { ...at, flowName: 'issue-to-pr' })).status).toBe(403);
      expect((await query('eve', 'triggers', at)).status).toBe(404);
    });

    test('starting a flow needs a running factory; removing an unknown trigger is 404', async () => {
      const start = { projectId: 'p1', flowName: 'issue-to-pr', inputs: {} };
      expect((await mutate('alice', 'runFlow', start)).status).toBe(404);

      await save('alice', { projectId: 'p1', enabled: false });
      const paused = await mutate('alice', 'runFlow', start);
      expect(paused.status).toBe(409);
      expect(paused.message).toContain('paused');
      expect(
        (await mutate('alice', 'removeTrigger', { projectId: 'p1', triggerId: 'x' })).status,
      ).toBe(404);
    });

    test('a run without an issue is listed with its trigger name and inputs', async () => {
      await save('alice', { projectId: 'p1', enabled: false });
      const { createFactorySettingsService } =
        await import('../../services/factory/factory-settings.js');
      const { createFactoryRunsRepository, factoryRunBranch } =
        await import('../../services/factory/factory-runs.js');
      const factoryId = (
        await createFactorySettingsService().factoryId('alice', 'p1')
      )._unsafeUnwrap()!;
      const run = (
        await createFactoryRunsRepository().start({
          factoryId,
          issueNumber: null,
          state: 'working',
          source: 'schedule',
          flowName: 'audit',
          trigger: { id: 't1', name: 'Nightly audit' },
          inputs: { scope: 'auth' },
        })
      )._unsafeUnwrap();

      expect(factoryRunBranch(run)).toBe(`factory/run-${run.id.slice(0, 8)}`);
      expect(factoryRunBranch({ id: run.id, issueNumber: 7 })).toBe(
        `factory/issue-7-${run.id.slice(0, 8)}`,
      );
      const listed = (await query('alice', 'runs', { projectId: 'p1' })).body;
      expect(listed).toEqual([
        expect.objectContaining({
          id: run.id,
          issueNumber: null,
          source: 'schedule',
          triggerName: 'Nightly audit',
          inputs: { scope: 'auth' },
        }),
      ]);
    });
  });
  describe('the spec stage (openspec factory-spec-stage)', () => {
    const DRAFT = {
      summary: 'Add a logout button',
      decisions: [{ question: 'Where does it live?', answer: 'In the user menu' }],
      behavior: [],
      approach: [],
      outOfScope: [],
      validation: ['Log out ends the session'],
      contract: { acceptanceCriteria: ['A user can log out'], likelyPaths: [], riskHints: [] },
    };

    /** A run parked on its spec, with a draft at revision 1. */
    async function draftRun() {
      const { createFactoryRunsRepository } =
        await import('../../services/factory/factory-runs.js');
      const runs = createFactoryRunsRepository();
      const run = await seededRun('triaging');
      await runs.updateInFlight(run.id, {
        state: 'needs_spec',
        triage: { decision: 'needs_spec', at: new Date().toISOString() },
      });
      await runs.updateSpec(run.id, () => ({
        threadId: 't-spec',
        revision: 1,
        latest: { status: 'draft', spec: DRAFT },
      }));
      return { run, runs };
    }

    test('a member approves the draft shown; the run goes back to the queue with its contract', async () => {
      const { run } = await draftRun();
      const approved = await mutate('alice', 'approveSpec', {
        projectId: 'p1',
        runId: run.id,
        revision: 1,
      });
      expect(approved).toMatchObject({
        status: 200,
        body: {
          state: 'requested',
          triage: { decision: 'ready', fromSpec: true, contract: DRAFT.contract },
          spec: { approved: { revision: 1, by: 'alice' } },
        },
      });
    });

    test('a stale revision, or a run no longer on its spec, is refused with 409', async () => {
      const { run, runs } = await draftRun();
      await runs.updateSpec(run.id, (current) => ({ ...current!, revision: 2 }));
      const stale = await mutate('alice', 'approveSpec', {
        projectId: 'p1',
        runId: run.id,
        revision: 1,
      });
      expect(stale.status).toBe(409);
      const ok = await mutate('alice', 'approveSpec', {
        projectId: 'p1',
        runId: run.id,
        revision: 2,
      });
      expect(ok.status).toBe(200);
      const again = await mutate('alice', 'approveSpec', {
        projectId: 'p1',
        runId: run.id,
        revision: 2,
      });
      expect(again.status).toBe(409);
    });

    test('a viewer may not approve or reopen a spec', async () => {
      const { run } = await draftRun();
      seedProjectMember(t.db, { projectId: 'p1', userId: 'vic', role: 'viewer' });
      const input = { projectId: 'p1', runId: run.id, revision: 1 };
      expect((await mutate('vic', 'approveSpec', input)).status).toBe(403);
      expect((await mutate('vic', 'reopenSpec', { projectId: 'p1', runId: run.id })).status).toBe(
        403,
      );
    });

    test('reopening a parked run drops the approval; one in flight is refused', async () => {
      const { run } = await draftRun();
      await mutate('alice', 'approveSpec', { projectId: 'p1', runId: run.id, revision: 1 });
      const reopened = await mutate('alice', 'reopenSpec', { projectId: 'p1', runId: run.id });
      expect(reopened).toMatchObject({ status: 200, body: { state: 'needs_spec' } });
      expect(reopened.body.spec.approved).toBeUndefined();

      const { runs } = await import('../../services/factory/factory-runs.js').then((m) => ({
        runs: m.createFactoryRunsRepository(),
      }));
      // Another issue: one open run per issue.
      const working = (
        await runs.start({ factoryId: run.factoryId, issueNumber: 8, state: 'working' })
      )._unsafeUnwrap();
      const refused = await mutate('alice', 'reopenSpec', { projectId: 'p1', runId: working.id });
      expect(refused.status).toBe(409);
    });

    test('an agent can only ask: the request is for the draft, and nothing is approved', async () => {
      const { factoryAgentTools } = await import('../../trpc/ports/factory.js');
      const { seedThread } = await import('../helpers/test-db.js');
      const { run } = await draftRun();
      seedThread(t.db, { id: 't-ask', projectId: 'p1', userId: 'alice' });
      const fromThread = { threadId: 't-ask', runnerId: 'laptop', runnerOwnerId: 'alice' };
      const asked = (await factoryAgentTools.requestApproval(fromThread, run.id))._unsafeUnwrap();
      expect(asked).toMatchObject({ state: 'pending', created: true });
      const listed = (await query('alice', 'approvalRequests', { projectId: 'p1' })).body;
      expect(listed).toEqual([
        expect.objectContaining({ kind: 'spec', specRevision: 1, state: 'pending' }),
      ]);
      const detail = (await factoryAgentTools.getRun(fromThread, run.id))._unsafeUnwrap();
      expect(detail.spec).toMatchObject({ status: 'draft', revision: 1, approved: null });
      expect((await query('alice', 'runs', { projectId: 'p1' })).body[0]).toMatchObject({
        state: 'needs_spec',
      });

      // The member approves the draft: the request closes as approved.
      await mutate('alice', 'approveSpec', { projectId: 'p1', runId: run.id, revision: 1 });
      const after = (await query('alice', 'approvalRequests', { projectId: 'p1' })).body;
      expect(after).toEqual([expect.objectContaining({ id: asked.requestId, state: 'approved' })]);
    });
  });
});
