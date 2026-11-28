/**
 * End-to-end server integration test for `factory-flow-bootstrap` (Task 6.1):
 *   1. Repository starts without `.funny/workflows/issue-to-merge.yaml` (falls back
 *      to built-in flow without regression_proof rules):
 *      - Enabling the factory is refused (`409 flow-not-ready`).
 *      - Member starts flow setup -> agent writes rules -> verifier runs -> proposal shown.
 *      - Member confirms -> fake runner commits flow + built-in prompts to default branch.
 *      - Enabling the factory now succeeds!
 *      - A queued issue can now be admitted (flow is proof-ready).
 *   2. Rejected-push path on a protected branch:
 *      - Confirm hits `branch-rule-rejected` -> state `push_rejected` with GitHub's reason.
 *      - Member opens pull request -> state `pr_open`, PR link recorded.
 *      - Factory enable is STILL refused until the PR lands on the default branch.
 */

import { describe, expect, mock, test } from 'bun:test';

import type { TestStackFacts } from '@funny/core';
import type { FactoryFlowValidation } from '@funny/shared/contracts/factory';
import { dbAll, dbGet, dbRun } from '@funny/shared/db/connection';
import { createFactoryFlowSetupRepository } from '@funny/shared/repositories';
import { loadWorkflowCatalog } from '@funny/workflows';
import { ok, ResultAsync } from 'neverthrow';

import { setConnection } from '../../../db/index.js';
import type {
  FactoryFlowSetupRunnerClient,
  VerifyFlowSetupResult,
} from '../../../services/factory/factory-flow-setup-runner.js';
import {
  createFactoryFlowSetupService,
  type FlowSetupRepoReader,
} from '../../../services/factory/factory-flow-setup.js';
import { loadFactoryFlow } from '../../../services/factory/factory-flow.js';
import { createFactorySettingsService } from '../../../services/factory/factory-settings.js';
import { createTestDb, seedProject, seedThread } from '../../helpers/test-db.js';

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
      sampleTests: ['packages/app/sample.test.ts'],
    },
  ],
  testPatterns: ['**/*.test.ts'],
  infrastructureTests: [],
};

const MANIFEST_MSG = [
  'Configured regression_proof.',
  '```json',
  JSON.stringify({
    canaries: [
      {
        ruleIndex: 0,
        passingPath: 'packages/app/__canary__.pass.test.ts',
        failingPath: 'packages/app/__canary__.fail.test.ts',
      },
    ],
    uncovered: [],
  }),
  '```',
].join('\n');

async function buildBuiltInWithRules(): Promise<string> {
  const { workflows } = await loadWorkflowCatalog();
  const builtIn = workflows.get('issue-to-merge')!.yaml;
  return builtIn.replace(
    /regression_proof:\s*\n\s*require_test:\s*always/,
    [
      'regression_proof:',
      '      rules:',
      '        - globs: ["**/*.test.ts"]',
      '          command: "bun test {{files}}"',
      '      require_test: always',
    ].join('\n'),
  );
}

function makePassingVerify(yaml: string): VerifyFlowSetupResult {
  return {
    acceptedCount: 1,
    rejectedCount: 0,
    timedOut: false,
    prunedWorkflowYaml: yaml,
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
          command: 'bun test packages/app/sample.test.ts',
          files: ['packages/app/sample.test.ts'],
          exitCode: 0,
          timedOut: false,
          aborted: false,
          output: 'packages/app/sample.test.ts pass',
        },
        twoFileRun: {
          command: 'bun test packages/app/__canary__.pass.test.ts packages/app/sample.test.ts',
          files: ['packages/app/__canary__.pass.test.ts', 'packages/app/sample.test.ts'],
          exitCode: 0,
          timedOut: false,
          aborted: false,
          output: 'packages/app/__canary__.pass.test.ts packages/app/sample.test.ts pass',
        },
      },
    ],
  };
}

describe('factory-flow-bootstrap integration (Task 6.1)', () => {
  test('no flow file -> enable refused -> generate -> verify -> confirm -> enable succeeds & flow ready for admission', async () => {
    const ctx = createTestDb();
    setConnection({
      db: ctx.db,
      schema: ctx.schema,
      sqlite: ctx.sqlite,
      mode: 'sqlite',
      close: async () => ctx.sqlite.close(),
    });
    seedProject(ctx.db, { id: 'p1', userId: 'u1' });
    const setupRepo = createFactoryFlowSetupRepository({
      db: ctx.db,
      schema: ctx.schema,
      dbAll,
      dbGet,
      dbRun,
    });

    // In-memory default branch files (initially empty — no .funny/workflows/issue-to-merge.yaml).
    const defaultBranchFiles = new Map<string, string>();
    const generatedWithRules = await buildBuiltInWithRules();

    const repoReader: FlowSetupRepoReader = {
      defaultBranchHead: async () => ok({ branch: 'main', sha: 'base-sha-000' }),
      readDefaultBranchFile: async (path) => ok(defaultBranchFiles.get(path) ?? null),
    };

    const settingsService = createFactorySettingsService({
      validateFlow: (_factoryId, _projectId, flowName) =>
        ResultAsync.fromSafePromise<FactoryFlowValidation, { message: string }>(
          (async (): Promise<FactoryFlowValidation> => {
            const loaded = await loadFactoryFlow(flowName, {
              readDefaultBranchFile: (p) => repoReader.readDefaultBranchFile(p),
            });
            if (loaded.isErr()) {
              return {
                ok: false,
                message: loaded.error.message,
                problems: [{ step: flowName, field: 'flow', message: loaded.error.message }],
              };
            }
            return {
              ok: true,
              name: flowName,
              source: loaded.value.source,
              commit: loaded.value.commit,
              proofReady: loaded.value.proofReady,
              steps: [],
              agentSteps: [],
              unusedOverrides: [],
              warnings: [],
            };
          })(),
        ),
    });

    // 1. Enable is refused before setup (built-in flow has no regression_proof rules).
    const enableBefore = await settingsService.save('u1', 'p1', {
      enabled: true,
      mode: 'automatic',
      label: 'ready-for-agent',
      flowName: 'issue-to-merge',
      maxConcurrent: 2,
    });
    expect(enableBefore.isErr()).toBe(true);
    expect(enableBefore._unsafeUnwrapErr().kind).toBe('flow-not-ready');

    // 2. Fake runner commits files directly into `defaultBranchFiles`.
    const runner: FactoryFlowSetupRunnerClient = {
      detectStack: mock(async () => ok(SAMPLE_FACTS)),
      readSetupFile: mock(async () =>
        ok({ path: '.funny/workflows/issue-to-merge.yaml', content: generatedWithRules }),
      ),
      sendFirstMessage: mock(async () => ok(undefined)),
      startVerify: mock(async () => ok({ jobId: 'verify-1', state: 'running' })),
      pollVerify: mock(async () =>
        ok({ state: 'done' as const, result: makePassingVerify(generatedWithRules) }),
      ),
      cancelVerify: mock(async () => ok(undefined)),
      commitAndPush: mock(async (_userId, _threadId, body) => {
        for (const f of body.files) {
          defaultBranchFiles.set(f.path, f.content);
        }
        return ok({ ok: true as const, commitSha: 'pushed-sha-1' });
      }),
      openPullRequest: mock(async () =>
        ok({ ok: true as const, prUrl: 'https://github.com/o/r/pull/1', prNumber: 1 }),
      ),
    };

    const setupService = createFactoryFlowSetupService({
      repo: setupRepo,
      runner,
      canSteer: async () => true,
      repoReader: async () => repoReader,
      launchThread: async (input) => {
        seedThread(ctx.db, {
          id: 't-setup-1',
          projectId: String(input.body.projectId ?? 'p1'),
          userId: input.userId,
          source: 'factory-setup',
          mode: 'worktree',
          branch: String(input.body.branch ?? 'funny/factory-setup/test'),
          worktreePath: '/tmp/wt/t-setup-1',
        });
        return ok({
          thread: { id: 't-setup-1', worktreePath: '/tmp/wt/t-setup-1' },
          threadId: 't-setup-1',
          runnerId: 'runner-u1',
        });
      },
      getLastAssistantMessage: async () => MANIFEST_MSG,
      cleanupWorkspace: async () => {},
      autoPollVerify: false,
    });

    // 3. Start setup -> thread completes -> verify -> proposed -> confirm.
    const started = (await setupService.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
    await setupService.onSetupThreadTerminal(started.threadId!, 'completed');
    await setupService.pollVerifyOnce(started.id);
    const proposed = (await setupRepo.getById(started.id))!;
    expect(proposed.state).toBe('proposed');

    const committed = (
      await setupService.confirmFlowSetup(
        { userId: 'u1' },
        proposed.id,
        proposed.proposedFileSha!,
        'rules',
      )
    )._unsafeUnwrap();
    expect(committed.state).toBe('committed');
    // Both the flow file and built-in prompt files were committed to default branch!
    expect(defaultBranchFiles.has('.funny/workflows/issue-to-merge.yaml')).toBe(true);
    expect(
      [...defaultBranchFiles.keys()].some((k) => k.startsWith('.funny/workflows/prompts/')),
    ).toBe(true);

    // 4. Enable now succeeds!
    const enableAfter = await settingsService.save('u1', 'p1', {
      enabled: true,
      mode: 'automatic',
      label: 'ready-for-agent',
      flowName: 'issue-to-merge',
      maxConcurrent: 2,
    });
    expect(enableAfter.isOk()).toBe(true);
    expect(enableAfter._unsafeUnwrap().enabled).toBe(true);

    // 5. Flow loaded for admission is now proof-ready!
    const loadedForAdmission = await loadFactoryFlow('issue-to-merge', {
      readDefaultBranchFile: (p) => repoReader.readDefaultBranchFile(p),
    });
    expect(loadedForAdmission.isOk()).toBe(true);
    expect(loadedForAdmission._unsafeUnwrap().source).toBe('repository');
    expect(loadedForAdmission._unsafeUnwrap().proofReady).toBe(true);
  });

  test('rejected-push path opens a pull request while factory remains off', async () => {
    const ctx = createTestDb();
    setConnection({
      db: ctx.db,
      schema: ctx.schema,
      sqlite: ctx.sqlite,
      mode: 'sqlite',
      close: async () => ctx.sqlite.close(),
    });
    seedProject(ctx.db, { id: 'p1', userId: 'u1' });
    const setupRepo = createFactoryFlowSetupRepository({
      db: ctx.db,
      schema: ctx.schema,
      dbAll,
      dbGet,
      dbRun,
    });

    const defaultBranchFiles = new Map<string, string>();
    const generatedWithRules = await buildBuiltInWithRules();
    const repoReader: FlowSetupRepoReader = {
      defaultBranchHead: async () => ok({ branch: 'main', sha: 'base-sha-000' }),
      readDefaultBranchFile: async (path) => ok(defaultBranchFiles.get(path) ?? null),
    };

    const settingsService = createFactorySettingsService({
      validateFlow: (_factoryId, _projectId, flowName) =>
        ResultAsync.fromSafePromise<FactoryFlowValidation, { message: string }>(
          (async (): Promise<FactoryFlowValidation> => {
            const loaded = await loadFactoryFlow(flowName, {
              readDefaultBranchFile: (p) => repoReader.readDefaultBranchFile(p),
            });
            if (loaded.isErr()) {
              return {
                ok: false,
                message: loaded.error.message,
                problems: [{ step: flowName, field: 'flow', message: loaded.error.message }],
              };
            }
            return {
              ok: true,
              name: flowName,
              source: loaded.value.source,
              commit: loaded.value.commit,
              proofReady: loaded.value.proofReady,
              steps: [],
              agentSteps: [],
              unusedOverrides: [],
              warnings: [],
            };
          })(),
        ),
    });

    const runner: FactoryFlowSetupRunnerClient = {
      detectStack: mock(async () => ok(SAMPLE_FACTS)),
      readSetupFile: mock(async () =>
        ok({ path: '.funny/workflows/issue-to-merge.yaml', content: generatedWithRules }),
      ),
      sendFirstMessage: mock(async () => ok(undefined)),
      startVerify: mock(async () => ok({ jobId: 'verify-1', state: 'running' })),
      pollVerify: mock(async () =>
        ok({ state: 'done' as const, result: makePassingVerify(generatedWithRules) }),
      ),
      cancelVerify: mock(async () => ok(undefined)),
      commitAndPush: mock(async () =>
        ok({
          ok: false as const,
          kind: 'branch-rule-rejected' as const,
          message: 'GH006: Protected branch update failed',
        }),
      ),
      openPullRequest: mock(async () =>
        ok({ ok: true as const, prUrl: 'https://github.com/o/r/pull/99', prNumber: 99 }),
      ),
    };

    const setupService = createFactoryFlowSetupService({
      repo: setupRepo,
      runner,
      canSteer: async () => true,
      repoReader: async () => repoReader,
      launchThread: async (input) => {
        seedThread(ctx.db, {
          id: 't-setup-pr',
          projectId: String(input.body.projectId ?? 'p1'),
          userId: input.userId,
          source: 'factory-setup',
          mode: 'worktree',
          branch: String(input.body.branch ?? 'funny/factory-setup/test'),
          worktreePath: '/tmp/wt/t-setup-pr',
        });
        return ok({
          thread: { id: 't-setup-pr', worktreePath: '/tmp/wt/t-setup-pr' },
          threadId: 't-setup-pr',
          runnerId: 'runner-u1',
        });
      },
      getLastAssistantMessage: async () => MANIFEST_MSG,
      cleanupWorkspace: async () => {},
      autoPollVerify: false,
    });

    const started = (await setupService.startFlowSetup({ userId: 'u1' }, 'p1'))._unsafeUnwrap();
    await setupService.onSetupThreadTerminal(started.threadId!, 'completed');
    await setupService.pollVerifyOnce(started.id);
    const proposed = (await setupRepo.getById(started.id))!;

    const rejected = (
      await setupService.confirmFlowSetup(
        { userId: 'u1' },
        proposed.id,
        proposed.proposedFileSha!,
        'rules',
      )
    )._unsafeUnwrap();
    expect(rejected.state).toBe('push_rejected');

    const prOpen = (
      await setupService.openFlowSetupPullRequest({ userId: 'u1' }, rejected.id)
    )._unsafeUnwrap();
    expect(prOpen.state).toBe('pr_open');
    expect(prOpen.prUrl).toBe('https://github.com/o/r/pull/99');

    // Factory still cannot be enabled until the PR merges to the default branch.
    const stillBlocked = await settingsService.save('u1', 'p1', {
      enabled: true,
      mode: 'automatic',
      label: 'ready-for-agent',
      flowName: 'issue-to-merge',
      maxConcurrent: 2,
    });
    expect(stillBlocked.isErr()).toBe(true);
    expect(stillBlocked._unsafeUnwrapErr().kind).toBe('flow-not-ready');
  });
});
