import { describe, expect, mock, test } from 'bun:test';

import type { TestStackFacts } from '@funny/core';
import { dbAll, dbGet, dbRun } from '@funny/shared/db/connection';
import { createFactoryFlowSetupRepository } from '@funny/shared/repositories';
import { err, ok } from 'neverthrow';

import type {
  FactoryFlowSetupRunnerClient,
  VerifyFlowSetupResult,
} from '../../../services/factory/factory-flow-setup-runner.js';
import {
  createFactoryFlowSetupService,
  sha256Hex,
  type FlowSetupActivityRecord,
  type FlowSetupRepoReader,
} from '../../../services/factory/factory-flow-setup.js';
import { createTestDb, seedProject, seedThread } from '../../helpers/test-db.js';

const REPO_FLOW_WITHOUT_RULES = `name: issue-to-merge
nodes:
  - id: implement
    spawn_agent:
      prompt: "Implement the issue"
  - id: proof
    depends_on: [implement]
    regression_proof:
      rules: []
  - id: merge
    depends_on: [proof]
    merge: {}
`;

const REPO_FLOW_WITH_RULES = `name: issue-to-merge
nodes:
  - id: implement
    spawn_agent:
      prompt: "Implement the issue"
  - id: proof
    depends_on: [implement]
    regression_proof:
      rules:
        - globs: ["**/*.test.ts"]
          command: "bun test {{files}}"
  - id: merge
    depends_on: [proof]
    merge: {}
`;

const SAMPLE_FACTS: TestStackFacts = {
  packageManager: 'bun',
  monorepo: 'bun-workspaces',
  recognized: true,
  summary: 'Detected bun workspaces with bun test.',
  packages: [
    {
      name: 'app',
      root: 'packages/app',
      runner: 'bun',
      configFile: null,
      nxTestTarget: false,
      testPatterns: ['**/*.test.ts'],
      sampleTests: ['packages/app/math.test.ts'],
    },
  ],
  testPatterns: ['**/*.test.ts'],
  infrastructureTests: [
    { path: 'packages/app/db.integration.test.ts', reason: 'integration test' },
  ],
};

const VALID_MANIFEST_MSG = [
  'Done configuring rules.',
  '```json',
  JSON.stringify({
    canaries: [
      {
        ruleIndex: 0,
        passingPath: 'packages/app/__canary__.pass.test.ts',
        failingPath: 'packages/app/__canary__.fail.test.ts',
      },
    ],
    uncovered: [{ scope: '**/*.integration.test.ts', reason: 'Needs Postgres' }],
  }),
  '```',
].join('\n');

function makePassingVerifyResult(prunedYaml: string): VerifyFlowSetupResult {
  return {
    acceptedCount: 1,
    rejectedCount: 0,
    timedOut: false,
    prunedWorkflowYaml: prunedYaml,
    rules: [
      {
        ruleIndex: 0,
        globs: ['**/*.test.ts'],
        command: 'bun test {{files}}',
        accepted: true,
        passingCanary: {
          command: 'bun test packages/app/__canary__.pass.test.ts',
          files: ['packages/app/__canary__.pass.test.ts'],
          exitCode: 0,
          timedOut: false,
          aborted: false,
          output: 'packages/app/__canary__.pass.test.ts pass',
        },
        failingCanary: {
          command: 'bun test packages/app/__canary__.fail.test.ts',
          files: ['packages/app/__canary__.fail.test.ts'],
          exitCode: 1,
          timedOut: false,
          aborted: false,
          output: 'packages/app/__canary__.fail.test.ts expect(1).toBe(2)',
        },
        existingTest: {
          command: 'bun test packages/app/math.test.ts',
          files: ['packages/app/math.test.ts'],
          exitCode: 0,
          timedOut: false,
          aborted: false,
          output: 'packages/app/math.test.ts pass',
        },
        twoFileRun: {
          command: 'bun test packages/app/__canary__.pass.test.ts packages/app/math.test.ts',
          files: ['packages/app/__canary__.pass.test.ts', 'packages/app/math.test.ts'],
          exitCode: 0,
          timedOut: false,
          aborted: false,
          output: 'packages/app/__canary__.pass.test.ts packages/app/math.test.ts pass',
        },
      },
    ],
  };
}

function createHarness(options?: {
  defaultBranchFile?: string | null;
  prState?: 'open' | 'merged' | 'closed';
  canSteer?: boolean;
  runnerOffline?: boolean;
  lastAssistantMessage?: string | null;
}) {
  const ctx = createTestDb();
  seedProject(ctx.db, { id: 'p1', userId: 'u1' });
  const repo = createFactoryFlowSetupRepository({
    db: ctx.db,
    schema: ctx.schema,
    dbAll,
    dbGet,
    dbRun,
  });

  let defaultBranchContent =
    options?.defaultBranchFile !== undefined ? options.defaultBranchFile : REPO_FLOW_WITHOUT_RULES;
  let prState: 'open' | 'merged' | 'closed' = options?.prState ?? 'open';
  let lastMessage: string | null =
    options?.lastAssistantMessage !== undefined ? options.lastAssistantMessage : VALID_MANIFEST_MSG;

  const activities: FlowSetupActivityRecord[] = [];
  const cleanups: Array<{ threadId: string; deleteBranch: boolean; reason: string }> = [];
  const events: Array<{ userId: string; projectId: string; setupId: string; state: string }> = [];

  const runner: FactoryFlowSetupRunnerClient = {
    detectStack: mock(async () => ok(SAMPLE_FACTS)),
    readSetupFile: mock(async () =>
      ok({ path: '.funny/workflows/issue-to-merge.yaml', content: REPO_FLOW_WITH_RULES }),
    ),
    sendFirstMessage: mock(async () => ok(undefined)),
    startVerify: mock(async () => ok({ jobId: 'job-1', state: 'running' })),
    pollVerify: mock(async () =>
      ok({ state: 'done' as const, result: makePassingVerifyResult(REPO_FLOW_WITH_RULES) }),
    ),
    cancelVerify: mock(async () => ok(undefined)),
    commitAndPush: mock(async () => ok({ ok: true as const, commitSha: 'commit-sha-1' })),
    openPullRequest: mock(async () =>
      ok({ ok: true as const, prUrl: 'https://github.com/o/r/pull/42', prNumber: 42 }),
    ),
  };

  let threadCounter = 0;
  const launchThread = mock(async (input: any) => {
    if (options?.runnerOffline) {
      return err({
        kind: 'runner-unavailable' as const,
        status: 502 as const,
        message: 'Your runner for this project is offline.',
      });
    }
    threadCounter += 1;
    const threadId = `t-setup-${threadCounter}`;
    seedThread(ctx.db, {
      id: threadId,
      projectId: input.body.projectId,
      userId: input.userId,
      source: 'factory-setup',
      mode: 'worktree',
      branch: input.body.branch,
      worktreePath: `/tmp/wt/${threadId}`,
    });
    return ok({
      thread: { id: threadId, worktreePath: `/tmp/wt/${threadId}` },
      threadId,
      runnerId: 'runner-u1',
    });
  });

  const repoReader: FlowSetupRepoReader = {
    defaultBranchHead: async () => ok({ branch: 'main', sha: 'base-sha-111' }),
    readDefaultBranchFile: async (path) => {
      if (path === '.funny/workflows/issue-to-merge.yaml') return ok(defaultBranchContent);
      return ok(null);
    },
    getPullRequestState: async () => ok(prState),
  };

  const service = createFactoryFlowSetupService({
    repo,
    runner,
    canSteer: async () => options?.canSteer ?? true,
    repoReader: async () => repoReader,
    launchThread,
    getLastAssistantMessage: async () => lastMessage,
    cleanupWorkspace: async (req) => {
      cleanups.push({
        threadId: req.threadId,
        deleteBranch: req.deleteBranch,
        reason: req.reason,
      });
    },
    recordActivity: async (rec) => {
      activities.push(rec);
    },
    emitEvent: (userId, projectId, setupId, state) => {
      events.push({ userId, projectId, setupId, state });
    },
    autoPollVerify: false,
  });

  return {
    ctx,
    repo,
    runner,
    launchThread,
    service,
    activities,
    cleanups,
    events,
    setDefaultBranchContent: (c: string | null) => {
      defaultBranchContent = c;
    },
    setPrState: (s: 'open' | 'merged' | 'closed') => {
      prState = s;
    },
    setLastMessage: (m: string | null) => {
      lastMessage = m;
    },
  };
}

describe('factory-flow-setup service', () => {
  describe('4.2 startFlowSetup', () => {
    test('creates idle factory-setup worktree thread, detects stack, and sends prompt', async () => {
      const h = createHarness();
      const res = await h.service.startFlowSetup({ userId: 'u1' }, 'p1');
      expect(res.isOk()).toBe(true);
      const setup = res._unsafeUnwrap();
      expect(setup.state).toBe('generating');
      expect(setup.defaultBranch).toBe('main');
      expect(setup.baseSha).toBe('base-sha-111');
      expect(setup.branch).toMatch(/^funny\/factory-setup\//);
      expect(setup.threadId).toBe('t-setup-1');
      expect(setup.startingSource).toBe('repo');
      expect(JSON.parse(setup.facts!)).toEqual(SAMPLE_FACTS);

      expect(h.launchThread).toHaveBeenCalledTimes(1);
      const launchArg = (h.launchThread as any).mock.calls[0][0];
      expect(launchArg.intent).toBe('idle');
      expect(launchArg.userId).toBe('u1');
      expect(launchArg.body.source).toBe('factory-setup');
      expect(launchArg.body.mode).toBe('worktree');
      expect(launchArg.body.baseBranch).toBe('main');

      expect(h.runner.detectStack).toHaveBeenCalledWith('u1', 't-setup-1');
      expect(h.runner.sendFirstMessage).toHaveBeenCalledTimes(1);
      const sentPrompt: string = (h.runner.sendFirstMessage as any).mock.calls[0][2];
      expect(sentPrompt).toContain('issue-to-merge');
      expect(sentPrompt).toContain('"packageManager": "bun"');
      expect(sentPrompt).toContain('Implement the issue');
    });

    test('bundles built-in prompt files when starting from a built-in flow', async () => {
      const h = createHarness({ defaultBranchFile: null });
      const res = await h.service.startFlowSetup({ userId: 'u1' }, 'p1');
      expect(res.isOk()).toBe(true);
      const setup = res._unsafeUnwrap();
      expect(setup.startingSource).toBe('builtin');
      const prompts = JSON.parse(setup.builtinPrompts!);
      expect(Array.isArray(prompts)).toBe(true);
      expect(prompts.length).toBeGreaterThan(0);
      expect(prompts[0].path).toMatch(/^\.funny\/workflows\/prompts\//);
    });

    test('refuses when caller lacks steer permission', async () => {
      const h = createHarness({ canSteer: false });
      const res = await h.service.startFlowSetup({ userId: 'u1' }, 'p1');
      expect(res.isErr()).toBe(true);
      expect(res._unsafeUnwrapErr().kind).toBe('forbidden');
      expect(h.launchThread).not.toHaveBeenCalled();
    });

    test('fails when member runner is offline without starting on another runner', async () => {
      const h = createHarness({ runnerOffline: true });
      const res = await h.service.startFlowSetup({ userId: 'u1' }, 'p1');
      expect(res.isErr()).toBe(true);
      expect(res._unsafeUnwrapErr().kind).toBe('runner-offline');
      expect(await h.repo.getOpenByUserProjectFlow('u1', 'p1', 'issue-to-merge')).toBeUndefined();
    });

    test('returns existing open setup on a second start without launching a new thread', async () => {
      const h = createHarness();
      const first = (await h.service.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
      const second = (await h.service.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
      expect(second.id).toBe(first.id);
      expect(h.launchThread).toHaveBeenCalledTimes(1);
    });

    test('refuses a flow file that does not parse', async () => {
      const h = createHarness({ defaultBranchFile: 'name: issue-to-merge\n  bad: [yaml' });
      const res = await h.service.startFlowSetup({ userId: 'u1' }, 'p1');
      expect(res.isErr()).toBe(true);
      expect(res._unsafeUnwrapErr().kind).toBe('invalid-flow');
      expect(h.launchThread).not.toHaveBeenCalled();
    });

    test('refuses a flow that is already proof-ready', async () => {
      const h = createHarness({ defaultBranchFile: REPO_FLOW_WITH_RULES });
      const res = await h.service.startFlowSetup({ userId: 'u1' }, 'p1');
      expect(res.isErr()).toBe(true);
      expect(res._unsafeUnwrapErr().kind).toBe('already-ready');
      expect(h.launchThread).not.toHaveBeenCalled();
    });
  });

  describe('4.4 onSetupThreadTerminal & verification', () => {
    test('marks setup failed when thread is stopped, failed, or deleted', async () => {
      for (const status of ['stopped', 'failed', 'deleted']) {
        const h = createHarness();
        const setup = (await h.service.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
        await h.service.onSetupThreadTerminal(setup.threadId!, status);
        const updated = await h.repo.getById(setup.id);
        expect(updated?.state).toBe('failed');
        expect(updated?.error).toContain(status);
      }
    });

    test('fails when generated file modifies anything outside regression_proof', async () => {
      const h = createHarness();
      const setup = (await h.service.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
      const tampered = REPO_FLOW_WITH_RULES.replace('Implement the issue', 'Hacked prompt');
      (h.runner.readSetupFile as any).mockResolvedValueOnce(
        ok({ path: '.funny/workflows/issue-to-merge.yaml', content: tampered }),
      );

      await h.service.onSetupThreadTerminal(setup.threadId!, 'completed');
      const updated = await h.repo.getById(setup.id);
      expect(updated?.state).toBe('failed');
      expect(updated?.error).toContain('more than regression_proof');
      expect(h.runner.startVerify).not.toHaveBeenCalled();
    });

    test('starts verification and transitions to proposed when rules pass', async () => {
      const h = createHarness();
      const setup = (await h.service.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();

      await h.service.onSetupThreadTerminal(setup.threadId!, 'completed');
      const verifying = await h.repo.getById(setup.id);
      expect(verifying?.state).toBe('verifying');
      expect(verifying?.verifyJobId).toBe('job-1');

      const pollStatus = await h.service.pollVerifyOnce(setup.id);
      expect(pollStatus).toBe('done');

      const proposed = await h.repo.getById(setup.id);
      expect(proposed?.state).toBe('proposed');
      expect(proposed?.proposedFile).toBe(REPO_FLOW_WITH_RULES);
      expect(proposed?.proposedFileSha).toBe(sha256Hex(REPO_FLOW_WITH_RULES));
      const verdicts = JSON.parse(proposed!.verdicts!);
      expect(verdicts.rules).toHaveLength(1);
      expect(verdicts.uncovered).toEqual([
        { scope: '**/*.integration.test.ts', reason: 'Needs Postgres' },
      ]);
    });

    test('transitions to failed when no rule survives verification', async () => {
      const h = createHarness();
      const setup = (await h.service.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
      (h.runner.pollVerify as any).mockResolvedValueOnce(
        ok({
          state: 'done',
          result: {
            acceptedCount: 0,
            rejectedCount: 1,
            timedOut: false,
            prunedWorkflowYaml: null,
            rules: [
              {
                ruleIndex: 0,
                globs: ['**/*.test.ts'],
                command: 'bun test {{files}}',
                accepted: false,
                rejectionReason: 'inconclusive',
              },
            ],
          },
        }),
      );

      await h.service.onSetupThreadTerminal(setup.threadId!, 'completed');
      await h.service.pollVerifyOnce(setup.id);

      const failed = await h.repo.getById(setup.id);
      expect(failed?.state).toBe('failed');
      expect(failed?.error).toContain('No generated regression proof rule passed');
    });
  });

  describe('4.5 confirm, pull request, opt-out, discard', () => {
    async function reachProposed(h: ReturnType<typeof createHarness>) {
      const setup = (await h.service.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
      await h.service.onSetupThreadTerminal(setup.threadId!, 'completed');
      await h.service.pollVerifyOnce(setup.id);
      return (await h.repo.getById(setup.id))!;
    }

    test('confirm commits, records activity, transitions to committed, and cleans up worktree + branch', async () => {
      const h = createHarness();
      const proposed = await reachProposed(h);

      const res = await h.service.confirmFlowSetup(
        { userId: 'u1' },
        proposed.id,
        proposed.proposedFileSha!,
        'rules',
      );
      expect(res.isOk()).toBe(true);
      const committed = res._unsafeUnwrap();
      expect(committed.state).toBe('committed');
      expect(committed.commitSha).toBe('commit-sha-1');
      expect(h.activities).toHaveLength(1);
      expect(h.activities[0]!.kind).toBe('factory.setup_push');
      expect(h.activities[0]!.ok).toBe(true);
      expect(h.cleanups).toEqual([
        { threadId: proposed.threadId!, deleteBranch: true, reason: 'factory-setup' },
      ]);
    });

    test('refuses confirm when fileSha changed since shown', async () => {
      const h = createHarness();
      const proposed = await reachProposed(h);

      const res = await h.service.confirmFlowSetup(
        { userId: 'u1' },
        proposed.id,
        'stale-sha',
        'rules',
      );
      expect(res.isErr()).toBe(true);
      const e = res._unsafeUnwrapErr();
      expect(e.kind).toBe('file-changed');
      if (e.kind === 'file-changed') {
        expect(e.currentSha).toBe(proposed.proposedFileSha!);
      }
      expect(h.runner.commitAndPush).not.toHaveBeenCalled();
    });

    test('refuses confirm, PR, and discard from another user', async () => {
      const h = createHarness();
      const proposed = await reachProposed(h);

      const c = await h.service.confirmFlowSetup(
        { userId: 'u2' },
        proposed.id,
        proposed.proposedFileSha!,
        'rules',
      );
      expect(c.isErr() && c.error.kind === 'forbidden').toBe(true);

      const d = await h.service.discardFlowSetup({ userId: 'u2' }, proposed.id);
      expect(d.isErr() && d.error.kind === 'forbidden').toBe(true);
    });

    test('branch-rule rejection transitions to push_rejected, then openFlowSetupPullRequest opens PR and cleans worktree only', async () => {
      const h = createHarness();
      const proposed = await reachProposed(h);

      (h.runner.commitAndPush as any).mockResolvedValueOnce(
        ok({
          ok: false,
          kind: 'branch-rule-rejected',
          message: 'GH006: Protected branch update failed (required status checks)',
        }),
      );

      const rejected = (
        await h.service.confirmFlowSetup(
          { userId: 'u1' },
          proposed.id,
          proposed.proposedFileSha!,
          'rules',
        )
      )._unsafeUnwrap();
      expect(rejected.state).toBe('push_rejected');
      expect(rejected.error ?? '').toContain('GH006');
      expect(h.cleanups).toHaveLength(0);

      const prOpened = (
        await h.service.openFlowSetupPullRequest({ userId: 'u1' }, proposed.id)
      )._unsafeUnwrap();
      expect(prOpened.state).toBe('pr_open');
      expect(prOpened.prNumber).toBe(42);
      expect(prOpened.prUrl).toBe('https://github.com/o/r/pull/42');
      expect(h.activities.map((a) => a.kind)).toEqual(['factory.setup_push', 'factory.setup_pr']);
      // Worktree only — branch kept for PR!
      expect(h.cleanups).toEqual([
        { threadId: proposed.threadId!, deleteBranch: false, reason: 'factory-setup' },
      ]);
    });

    test('opt-out works from failed state and commits require_regression_proof: false', async () => {
      const h = createHarness();
      const setup = (await h.service.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
      await h.service.onSetupThreadTerminal(setup.threadId!, 'stopped');

      const res = await h.service.confirmFlowSetup({ userId: 'u1' }, setup.id, '', 'opt-out');
      expect(res.isOk()).toBe(true);
      const committed = res._unsafeUnwrap();
      expect(committed.state).toBe('committed');
      expect(committed.proposedFile ?? '').toContain('require_regression_proof: false');
    });

    test('discard transitions to discarded and cleans up worktree + branch', async () => {
      const h = createHarness();
      const proposed = await reachProposed(h);

      const res = await h.service.discardFlowSetup({ userId: 'u1' }, proposed.id);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap().state).toBe('discarded');
      expect(h.cleanups).toEqual([
        { threadId: proposed.threadId!, deleteBranch: true, reason: 'factory-setup' },
      ]);
    });
  });

  describe('4.6 reconcileFlowSetups', () => {
    test('fails verifying setup whose runner job disappeared (404)', async () => {
      const h = createHarness();
      const setup = (await h.service.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
      await h.service.onSetupThreadTerminal(setup.threadId!, 'completed');
      (h.runner.pollVerify as any).mockResolvedValueOnce(
        err({ kind: 'not-found', message: 'verify-job-not-found' }),
      );

      await h.service.reconcileFlowSetups();
      const updated = await h.repo.getById(setup.id);
      expect(updated?.state).toBe('failed');
      expect(updated?.error).toContain('lost');
    });

    test('settles committing setup: committed if file on default branch, else back to proposed', async () => {
      const h = createHarness();
      const setup = (await h.service.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
      await h.service.onSetupThreadTerminal(setup.threadId!, 'completed');
      await h.service.pollVerifyOnce(setup.id);
      const proposed = (await h.repo.getById(setup.id))!;

      // Move to committing without finishing (simulate server crash mid-push)
      await h.repo.transition(proposed.id, 'committing', { commitVariant: 'rules' });

      // Case 1: file NOT on default branch → returns to proposed
      await h.service.reconcileFlowSetups();
      expect((await h.repo.getById(proposed.id))?.state).toBe('proposed');

      // Case 2: file IS on default branch → settles to committed + cleans up
      await h.repo.transition(proposed.id, 'committing', { commitVariant: 'rules' });
      h.setDefaultBranchContent(REPO_FLOW_WITH_RULES);
      await h.service.reconcileFlowSetups();
      expect((await h.repo.getById(proposed.id))?.state).toBe('committed');
      expect(h.cleanups).toHaveLength(1);
    });

    test('settles pr_open setup when file lands on default branch or PR closes', async () => {
      const h1 = createHarness();
      const s1 = (await h1.service.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
      await h1.service.onSetupThreadTerminal(s1.threadId!, 'completed');
      await h1.service.pollVerifyOnce(s1.id);
      await h1.repo.transition(s1.id, 'committing', { commitVariant: 'rules' });
      await h1.repo.transition(s1.id, 'push_rejected', { error: 'protected' });
      await h1.repo.transition(s1.id, 'pr_open', {
        prNumber: 42,
        prUrl: 'https://github.com/o/r/pull/42',
      });

      h1.setDefaultBranchContent(REPO_FLOW_WITH_RULES);
      await h1.service.reconcileFlowSetups();
      expect((await h1.repo.getById(s1.id))?.state).toBe('committed');

      // Closed PR → discarded
      const h2 = createHarness({ prState: 'closed' });
      const s2 = (await h2.service.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
      await h2.service.onSetupThreadTerminal(s2.threadId!, 'completed');
      await h2.service.pollVerifyOnce(s2.id);
      await h2.repo.transition(s2.id, 'committing', { commitVariant: 'rules' });
      await h2.repo.transition(s2.id, 'push_rejected', { error: 'protected' });
      await h2.repo.transition(s2.id, 'pr_open', {
        prNumber: 43,
        prUrl: 'https://github.com/o/r/pull/43',
      });

      await h2.service.reconcileFlowSetups();
      expect((await h2.repo.getById(s2.id))?.state).toBe('discarded');
      // A closed pull request's branch is gone with it: worktree and branch removed.
      expect(h2.cleanups).toEqual([expect.objectContaining({ deleteBranch: true })]);
    });
  });
});
