/**
 * The factory tools an agent has (openspec factory-agent-tools): where they
 * are refused, that they act as the thread's owner on that owner's factory
 * only, and that asking for an approval never gives one. Real test DB; the
 * board's control is a fake that records what it was asked.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { errAsync, okAsync } from 'neverthrow';

import {
  createFactoryAgentTools,
  factoryToolAccess,
  isAgentRunControl,
  type FactoryToolAction,
  type ToolThread,
} from '../../../services/factory/factory-agent-tools.js';
import { createFactoryApprovalRequestsRepository } from '../../../services/factory/factory-approval-requests.js';
import {
  createFactoryRunsRepository,
  type FactoryRunView,
} from '../../../services/factory/factory-runs.js';
import { createFactorySettingsService } from '../../../services/factory/factory-settings.js';
import { createTestDb, seedProject, seedProjectMember } from '../../helpers/test-db.js';

const thread = (over: Partial<ToolThread> = {}): ToolThread => ({
  id: 't1',
  userId: 'alice',
  projectId: 'p1',
  isScratch: false,
  readOnly: false,
  runtime: 'local',
  source: 'web',
  ...over,
});
const facts = { runnerOwnerId: 'alice', sandboxRunner: false, steerShared: false };
const ALL: FactoryToolAction[] = ['list', 'retry', 'stop', 'request-approval'];

describe('factoryToolAccess', () => {
  test("allows every tool in the owner's own project thread", () => {
    for (const action of ALL) expect(factoryToolAccess(thread(), action, facts)).toBeNull();
  });

  test('refuses every tool in a sandbox, read-only, scratch or factory thread', () => {
    const refusedThreads = [
      thread({ runtime: 'sandbox' }),
      thread({ readOnly: true }),
      thread({ isScratch: true, projectId: null }),
      thread({ source: 'factory' }),
      null,
    ];
    for (const refusedThread of refusedThreads) {
      for (const action of ALL) {
        expect(factoryToolAccess(refusedThread, action, facts)).toEqual(expect.any(String));
      }
    }
    // A sandbox runner is refused whatever the thread row says.
    expect(factoryToolAccess(thread(), 'list', { ...facts, sandboxRunner: true })).toContain(
      'sandbox',
    );
  });

  test("another user's thread reads as not found", () => {
    expect(factoryToolAccess(thread({ userId: 'bob' }), 'list', facts)).toBe('Thread not found.');
  });

  test('a thread shared for steering can list and nothing else', () => {
    const shared = { ...facts, steerShared: true };
    expect(factoryToolAccess(thread(), 'list', shared)).toBeNull();
    for (const action of [
      'retry',
      'stop',
      'mark-done',
      'close-replaced-pr',
      'request-approval',
    ] as const) {
      expect(factoryToolAccess(thread(), action, shared)).toContain('shared for steering');
    }
  });
});

describe('factory agent tools', () => {
  let runs: ReturnType<typeof createFactoryRunsRepository>;
  let requests: ReturnType<typeof createFactoryApprovalRequestsRepository>;
  let F: { alice: string; bob: string; alice2: string };
  let world: {
    threads: Record<string, ToolThread>;
    steerShared: boolean;
    canSteer: boolean;
    factories: Record<string, string>;
    controls: Array<{
      action: string;
      userId: string;
      projectId: string;
      runId: string;
      threadId: string;
    }>;
    controlFails?: { status: number; message: string };
  };

  beforeEach(async () => {
    const testDb = createTestDb();
    const { setConnection } = await import('../../../db/index.js');
    setConnection({
      db: testDb.db,
      schema: testDb.schema,
      sqlite: testDb.sqlite,
      mode: 'sqlite',
      close: async () => testDb.sqlite.close(),
    });
    runs = createFactoryRunsRepository();
    requests = createFactoryApprovalRequestsRepository();
    seedProject(testDb.db, { id: 'p1', userId: 'alice', path: '/repo-1' });
    seedProject(testDb.db, { id: 'p2', userId: 'alice', path: '/repo-2' });
    seedProjectMember(testDb.db, { projectId: 'p1', userId: 'bob', role: 'member' });
    const settings = createFactorySettingsService();
    const factoryOf = async (userId: string, projectId: string) => {
      (await settings.save(userId, projectId, { enabled: false }))._unsafeUnwrap();
      return (await settings.factoryId(userId, projectId))._unsafeUnwrap()!;
    };
    F = {
      alice: await factoryOf('alice', 'p1'),
      bob: await factoryOf('bob', 'p1'),
      alice2: await factoryOf('alice', 'p2'),
    };
    world = {
      threads: { t1: thread(), 't-other': thread({ id: 't-other', projectId: 'p2' }) },
      steerShared: false,
      canSteer: true,
      factories: { 'alice:p1': F.alice, 'bob:p1': F.bob, 'alice:p2': F.alice2 },
      controls: [],
    };
  });

  const tools = () =>
    createFactoryAgentTools({
      loadThread: async (id) => world.threads[id] ?? null,
      hasSteerShare: async () => world.steerShared,
      sandboxThreadOfRunner: async () => null,
      canSteer: async () => world.canSteer,
      factoryId: (userId, projectId) => okAsync(world.factories[`${userId}:${projectId}`] ?? null),
      runs,
      requests,
      control: (action, userId, projectId, runId, threadId) => {
        world.controls.push({ action, userId, projectId, runId, threadId });
        if (world.controlFails) return errAsync(world.controlFails);
        return runs
          .get(runId)
          .mapErr(() => ({ status: 500, message: 'storage' }))
          .map((run) => run!);
      },
    });

  const from = (threadId = 't1') => ({ threadId, runnerId: 'laptop', runnerOwnerId: 'alice' });
  const A = 'a'.repeat(40);

  async function seedRun(
    factoryId: string,
    issueNumber: number,
    state: FactoryRunView['state'],
    held?: string,
  ): Promise<FactoryRunView> {
    const run = (await runs.start({ factoryId, issueNumber, state }))._unsafeUnwrap();
    if (held) {
      await runs.update(run.id, {
        failureReason: 'high risk',
        risk: {
          headSha: held,
          level: 'high',
          reasons: ['touches\na migration'],
          changedLines: 900,
          paths: [],
        },
      });
    }
    return (await runs.get(run.id))._unsafeUnwrap()!;
  }

  test("lists the owner's runs of the thread's project, and nobody else's", async () => {
    const mine = await seedRun(F.alice, 7, 'waiting_human', A);
    await seedRun(F.bob, 8, 'working');
    await seedRun(F.alice2, 9, 'working');

    const listed = (await tools().listRuns(from()))._unsafeUnwrap();
    expect(listed.factory).toBe(true);
    expect(listed.runs.map((run) => run.issueNumber)).toEqual([7]);
    expect(listed.runs[0]).toMatchObject({
      id: mine.id,
      state: 'waiting_human',
      awaitsApproval: true,
      approvedSha: null,
      approvalRequest: null,
      // One line, whatever the stored text holds.
      risk: { level: 'high', headSha: A, reasons: ['touches a migration'] },
    });
  });

  // openspec factory-merge-fewer-bounces, D2: asked again after the member approved another commit.
  test('a run held again says what changed since the approved commit', async () => {
    const approved = 'e'.repeat(40);
    const run = await seedRun(F.alice, 7, 'waiting_human', A);
    await runs.approveMerge(run.id, { sha: approved, userId: 'alice', at: 'now' });
    await runs.noteApprovalGap(run.id, approved, {
      to: A,
      at: 'later',
      lines: 8,
      files: ['src/new.ts'],
      moreFiles: 0,
      newFiles: ['src/new.ts'],
      newRiskKeys: [],
      reason: 'the change now touches src/new.ts, which the approved commit did not',
    });

    const listed = (await tools().listRuns(from()))._unsafeUnwrap();
    expect(listed.runs[0]).toMatchObject({
      awaitsApproval: true,
      approvedSha: approved,
      sinceApproval: {
        approvedSha: approved,
        lines: 8,
        files: ['src/new.ts'],
        moreFiles: 0,
        newFiles: ['src/new.ts'],
        newRiskKeys: [],
      },
    });
  });

  test('a first hold has no difference to show', async () => {
    await seedRun(F.alice, 7, 'waiting_human', A);
    const listed = (await tools().listRuns(from()))._unsafeUnwrap();
    expect(listed.runs[0]?.sinceApproval).toBeNull();
  });

  test('answers that there is no factory instead of failing', async () => {
    world.factories = {};
    expect((await tools().listRuns(from()))._unsafeUnwrap()).toEqual({ factory: false, runs: [] });
  });

  test('retries as the thread owner, through the board control, naming the thread', async () => {
    const run = await seedRun(F.alice, 7, 'failed');
    const retried = await tools().controlRun(from(), 'retry', run.id);
    expect(retried.isOk()).toBe(true);
    expect(world.controls).toEqual([
      { action: 'retry', userId: 'alice', projectId: 'p1', runId: run.id, threadId: 't1' },
    ]);
  });

  test('marks a run done as the thread owner, through the board control', async () => {
    const run = await seedRun(F.alice, 7, 'stopped');
    const marked = await tools().controlRun(from(), 'mark-done', run.id);
    expect(marked.isOk()).toBe(true);
    expect(world.controls).toEqual([
      { action: 'mark-done', userId: 'alice', projectId: 'p1', runId: run.id, threadId: 't1' },
    ]);
  });

  // The data channel names a control, never a state; anything else is refused.
  test('only named controls are agent controls', () => {
    for (const control of ['retry', 'stop', 'mark-done', 'close-replaced-pr']) {
      expect(isAgentRunControl(control)).toBe(true);
    }
    for (const other of ['done', 'merged', 'approve-merge', 'split', undefined]) {
      expect(isAgentRunControl(other)).toBe(false);
    }
  });

  test("passes the board's refusal on, and changes nothing", async () => {
    const run = await seedRun(F.alice, 7, 'working');
    world.controlFails = { status: 409, message: 'Only a failed run can be retried.' };
    const refused = await tools().controlRun(from(), 'retry', run.id);
    expect(refused._unsafeUnwrapErr()).toEqual({
      kind: 'conflict',
      message: 'Only a failed run can be retried.',
    });
  });

  test("a run of another project or another member's factory is not found", async () => {
    const bobs = await seedRun(F.bob, 8, 'failed');
    const elsewhere = await seedRun(F.alice2, 9, 'failed');
    for (const run of [bobs, elsewhere]) {
      const result = await tools().controlRun(from(), 'stop', run.id);
      expect(result._unsafeUnwrapErr().kind).toBe('not-found');
    }
    expect(world.controls).toEqual([]);
  });

  test('an owner who lost steer controls nothing', async () => {
    const run = await seedRun(F.alice, 7, 'failed');
    world.canSteer = false;
    expect((await tools().controlRun(from(), 'retry', run.id))._unsafeUnwrapErr().kind).toBe(
      'refused',
    );
    expect((await tools().requestApproval(from(), run.id))._unsafeUnwrapErr().kind).toBe('refused');
    expect(world.controls).toEqual([]);
  });

  test('a steer-shared thread lists, and is refused the rest', async () => {
    const run = await seedRun(F.alice, 7, 'waiting_human', A);
    world.steerShared = true;
    expect((await tools().listRuns(from())).isOk()).toBe(true);
    expect((await tools().controlRun(from(), 'stop', run.id))._unsafeUnwrapErr().kind).toBe(
      'refused',
    );
    expect((await tools().requestApproval(from(), run.id))._unsafeUnwrapErr().kind).toBe('refused');
    expect((await requests.pendingForRun(run.id))._unsafeUnwrap()).toBeNull();
  });

  test('asking for an approval makes one request and approves nothing', async () => {
    const run = await seedRun(F.alice, 7, 'waiting_human', A);
    const first = (await tools().requestApproval(from(), run.id))._unsafeUnwrap();
    expect(first).toMatchObject({ sha: A, state: 'pending', created: true });
    const again = (await tools().requestApproval(from(), run.id))._unsafeUnwrap();
    expect(again).toMatchObject({ requestId: first.requestId, created: false });

    // The run is exactly as it was: held, with no approval.
    expect((await runs.get(run.id))._unsafeUnwrap()).toMatchObject({
      state: 'waiting_human',
      mergeApproval: null,
    });
    const listed = (await tools().listRuns(from()))._unsafeUnwrap();
    expect(listed.runs[0].approvalRequest).toEqual({
      id: first.requestId,
      state: 'pending',
      sha: A,
    });
  });

  test('a run that is not held gets no request', async () => {
    const working = await seedRun(F.alice, 7, 'working');
    const asked = await tools().requestApproval(from(), working.id);
    expect(asked._unsafeUnwrapErr().kind).toBe('conflict');
    expect((await requests.listForFactory(F.alice))._unsafeUnwrap()).toEqual([]);
  });

  test('the agent reads the outcome: a request expires when the held commit changes', async () => {
    const run = await seedRun(F.alice, 7, 'waiting_human', A);
    const asked = (await tools().requestApproval(from(), run.id))._unsafeUnwrap();
    const B = 'b'.repeat(40);
    await runs.update(run.id, {
      risk: { headSha: B, level: 'high', reasons: ['big'], changedLines: 901, paths: [] },
    });
    const listed = (await tools().listRuns(from()))._unsafeUnwrap();
    expect(listed.runs[0].approvalRequest).toEqual({
      id: asked.requestId,
      state: 'expired',
      sha: A,
    });
  });
});
