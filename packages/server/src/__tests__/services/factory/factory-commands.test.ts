/**
 * A flow's `run_command` in the issue factory (openspec factory-integration
 * 2.1, 2.2): the server only asks the run's runner, which runs it in the run's
 * checkout; its exit decides the step; the flow loader refuses what the runner
 * would not do.
 */
import { describe, expect, test } from 'bun:test';

import { err, ok, okAsync } from 'neverthrow';

import { createFactoryActionProvider } from '../../../services/factory/factory-action-provider.js';
import { loadFactoryFlow, type FactoryFlowError } from '../../../services/factory/factory-flow.js';
import { RUNNER_UNAVAILABLE_PREFIX } from '../../../services/factory/factory-runner-jobs.js';
import {
  runStepOnRunner,
  type FactoryStepDeps,
} from '../../../services/factory/factory-step-runner.js';

const scope = {
  runId: 'r1',
  userId: 'alice',
  projectId: 'p1',
  repo: 'o/r',
  mode: 'local' as const,
  issueNumber: 7,
  issueTitle: 'Fix it',
  branch: 'factory/issue-7-r1',
};

const commandResult = (over: Record<string, unknown> = {}) => ({
  kind: 'command',
  outcome: 'passed',
  exitCode: 0,
  stdout: 'all good',
  stderr: '',
  durationMs: 12,
  ...over,
});

/** A runner that answers `polls` in order (the last repeats) and records what it started. */
function runner(
  polls: Array<ReturnType<FactoryStepDeps['pollStep']> extends Promise<infer R> ? R : never>,
) {
  const started: Array<{ threadId: string; body: Record<string, unknown> }> = [];
  const cancelled: string[] = [];
  let looks = 0;
  const steps: FactoryStepDeps = {
    startStep: async (threadId, body) => {
      started.push({ threadId, body });
      return ok({ stepId: 's1', state: 'running' });
    },
    pollStep: async () => polls[Math.min(looks++, polls.length - 1)]!,
    cancelStep: async (_threadId, stepId) => {
      cancelled.push(stepId);
    },
    pollMs: 1,
    offlineGraceMs: 20,
  };
  return { steps, started, cancelled };
}

function provider(steps: FactoryStepDeps | undefined, threadIds: string[] = ['impl']) {
  return createFactoryActionProvider({
    scope,
    threadIds,
    prUrl: null,
    launchStartedAt: null,
    findLaunched: async () => null,
    launch: async () => ok({ thread: { id: 't' }, threadId: 't', runnerId: 'r' }),
    waitThread: async () => ({ status: 'completed' as const, output: 'done' }),
    steps,
    github: {
      branchAhead: () => okAsync(true),
      commentOnIssue: () => okAsync(undefined),
      findPullRequest: () => okAsync(null),
      pullRequests: {} as never,
    },
    record: async () => undefined,
    signal: new AbortController().signal,
  });
}

describe('runStepOnRunner', () => {
  test('polls until the step is done and returns its result', async () => {
    const { steps, started } = runner([
      ok({ state: 'running' }),
      ok({ state: 'done', result: commandResult() }),
    ]);
    const run = await runStepOnRunner(
      steps,
      'impl',
      { kind: 'command', command: 'bun test', timeoutMs: 5_000 },
      new AbortController().signal,
    );
    expect(run).toMatchObject({ kind: 'done', result: { outcome: 'passed', stdout: 'all good' } });
    expect(started).toEqual([
      { threadId: 'impl', body: { kind: 'command', command: 'bun test', timeoutMs: 5_000 } },
    ]);
  });

  test('a runner that lost the step does not start it again', async () => {
    const { steps, started } = runner([err('step-not-found')]);
    const run = await runStepOnRunner(
      steps,
      'impl',
      { kind: 'command', command: 'x', timeoutMs: 5_000 },
      new AbortController().signal,
    );
    expect(run).toEqual({ kind: 'unavailable', why: 'the runner restarted during the step.' });
    expect(started).toHaveLength(1);
  });

  test('an unreachable runner is waited for, then given up on', async () => {
    const { steps } = runner([err(`${RUNNER_UNAVAILABLE_PREFIX}offline`)]);
    const run = await runStepOnRunner(
      steps,
      'impl',
      { kind: 'command', command: 'x', timeoutMs: 5_000 },
      new AbortController().signal,
    );
    expect(run).toMatchObject({ kind: 'unavailable', why: expect.stringContaining('offline') });
  });

  test('a stopped run stops the step on the runner', async () => {
    const { steps, cancelled } = runner([ok({ state: 'running' })]);
    const controller = new AbortController();
    controller.abort();
    const run = await runStepOnRunner(
      steps,
      'impl',
      { kind: 'command', command: 'x', timeoutMs: 5_000 },
      controller.signal,
    );
    expect(run).toEqual({ kind: 'unavailable', why: 'the run was stopped.' });
    expect(cancelled).toEqual(['s1']);
  });
});

describe('run_command in the action provider', () => {
  test("runs on the implementing thread's runner and passes with its output", async () => {
    const { steps, started } = runner([ok({ state: 'done', result: commandResult() })]);
    const result = await provider(steps).runCommand({
      command: 'bun test',
      cwd: '',
      timeout: 1_000,
    });
    expect(result).toMatchObject({ ok: true, output: 'all good', metadata: { exitCode: 0 } });
    expect(started[0]).toMatchObject({
      threadId: 'impl',
      body: { kind: 'command', command: 'bun test', timeoutMs: 1_000 },
    });
  });

  test('a non-zero exit fails the step with the end of its output', async () => {
    const { steps } = runner([
      ok({
        state: 'done',
        result: commandResult({ outcome: 'failed', exitCode: 2, stderr: 'lint error in a.ts' }),
      }),
    ]);
    const result = await provider(steps).runCommand({ command: 'bun run lint', cwd: '' });
    expect(result).toMatchObject({ ok: false, error: 'The command exited 2:\nlint error in a.ts' });
  });

  test('a timeout fails the step and says so', async () => {
    const { steps } = runner([
      ok({ state: 'done', result: commandResult({ outcome: 'timed-out', exitCode: null }) }),
    ]);
    const result = await provider(steps).runCommand({ command: 'sleep 999', cwd: '' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('timed-out') });
  });

  test('without a runner or a checkout yet, nothing runs (and never on the server)', async () => {
    expect((await provider(undefined).runCommand({ command: 'x', cwd: '' })).ok).toBe(false);
    const { steps, started } = runner([ok({ state: 'done', result: commandResult() })]);
    const none = await provider(steps, []).runCommand({ command: 'x', cwd: '' });
    expect(none).toMatchObject({ ok: false, error: expect.stringContaining('agent step') });
    expect(started).toEqual([]);
  });
});

describe('run_command in a factory flow', () => {
  const flow = (nodes: string) => ({
    readDefaultBranchFile: async (path: string) =>
      ok(path === '.funny/workflows/custom.yaml' ? `name: custom\nnodes:\n${nodes}` : null),
  });
  const invalid = (error: FactoryFlowError) => {
    if (error.kind !== 'invalid') throw new Error(`expected invalid, got ${error.kind}`);
    return error;
  };

  test('a command after the agent step loads', async () => {
    const loaded = await loadFactoryFlow(
      'custom',
      flow(`  - id: implement
    spawn_agent: { prompt: go }
  - id: lint
    depends_on: [implement]
    run_command: { command: 'bun run lint', timeout_ms: 600000 }
`),
    );
    expect(loaded.isOk()).toBe(true);
  });

  test('cwd and a timeout over an hour are refused, naming the step', async () => {
    const loaded = await loadFactoryFlow(
      'custom',
      flow(`  - id: implement
    spawn_agent: { prompt: go }
  - id: lint
    depends_on: [implement]
    run_command: { command: 'bun run lint', cwd: packages/a, timeout_ms: 7200000 }
`),
    );
    expect(invalid(loaded._unsafeUnwrapErr()).problems).toEqual([
      { step: 'lint', field: 'cwd', message: expect.any(String) },
      { step: 'lint', field: 'timeout_ms', message: expect.any(String) },
    ]);
  });

  test('a command in parallel with an agent step is refused: one checkout, one at a time', async () => {
    const loaded = await loadFactoryFlow(
      'custom',
      flow(`  - id: implement
    spawn_agent: { prompt: go }
  - id: lint
    run_command: { command: 'bun run lint' }
`),
    );
    expect(loaded._unsafeUnwrapErr().message).toContain('"implement" and "lint"');
  });
});
