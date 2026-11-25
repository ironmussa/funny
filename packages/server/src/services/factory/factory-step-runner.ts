/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * Run a factory step (a flow's `run_command`, or `integrate`) on the runner of
 * a run's thread and wait for it (openspec factory-integration, D5-D6). The
 * runner executes it in the thread's checkout; the server only starts it,
 * polls it and stops it when the run stops.
 *
 * Unlike a proof, a step that the runner lost (it restarted) is not started
 * again: a command may have had effects, so the step fails and the flow decides.
 */

import { sleep as interruptibleSleep } from '@funny/shared/async';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import { RUNNER_UNAVAILABLE_PREFIX } from './factory-runner-jobs.js';

/** Start, poll and stop a factory step on the runner of a run's thread. */
export interface FactoryStepDeps {
  startStep(
    threadId: string,
    body: Record<string, unknown>,
  ): Promise<Result<{ stepId: string; state: string }, string>>;
  pollStep(
    threadId: string,
    stepId: string,
  ): Promise<Result<{ state: string; result?: unknown }, string>>;
  cancelStep?(threadId: string, stepId: string): Promise<void>;
  /** How often a running step is polled (tests shorten it). */
  pollMs?: number;
  /** How long the runner may stay unreachable before the wait ends (tests shorten it). */
  offlineGraceMs?: number;
}

const commandResultSchema = z.object({
  kind: z.literal('command'),
  outcome: z.enum(['passed', 'failed', 'timed-out', 'stopped']),
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
});

const integrateResultSchema = z.object({
  kind: z.literal('integrate'),
  outcome: z.enum(['up-to-date', 'merged', 'conflict', 'failed']),
  headBefore: z.string(),
  headAfter: z.string(),
  resolvedPaths: z.array(z.string()),
  regeneratedPaths: z.array(z.string()),
  conflictedPaths: z.array(z.string()),
  baseDiff: z.string().default(''),
  weave: z.boolean(),
  message: z.string(),
});

const changeDeltaResultSchema = z.object({
  kind: z.literal('change-delta'),
  outcome: z.enum(['compared', 'failed']),
  ancestor: z.boolean(),
  lines: z.number().int().min(0),
  files: z.array(z.object({ path: z.string(), lines: z.number().int().min(0) })),
  filesTruncated: z.boolean(),
  outsideFrom: z.array(z.string()),
  message: z.string(),
});

const stepResultSchema = z.discriminatedUnion('kind', [
  commandResultSchema,
  integrateResultSchema,
  changeDeltaResultSchema,
]);

export type IntegrateStepResult = z.infer<typeof integrateResultSchema>;
export type FactoryStepResult = z.infer<typeof stepResultSchema>;
/** How a pull request's change differs at two commits (runtime `factory-change-delta.ts`). */
export type ChangeDelta = Omit<
  z.infer<typeof changeDeltaResultSchema>,
  'kind' | 'outcome' | 'message'
>;

export type StepRun =
  | { kind: 'done'; result: FactoryStepResult }
  | { kind: 'unavailable'; why: string };

const STEP_POLL_MS = 2_000;
const STEP_OFFLINE_GRACE_MS = 3 * 60_000;

/** What one poll says: the step's end, or keep waiting (`offline`: the runner could not be reached). */
type PollVerdict = { kind: 'end'; run: StepRun } | { kind: 'wait'; offline: boolean };

function verdictOf(polled: Result<{ state: string; result?: unknown }, string>): PollVerdict {
  if (polled.isErr()) {
    if (polled.error.startsWith(RUNNER_UNAVAILABLE_PREFIX)) return { kind: 'wait', offline: true };
    const why =
      polled.error === 'step-not-found' ? 'the runner restarted during the step.' : polled.error;
    return { kind: 'end', run: { kind: 'unavailable', why } };
  }
  if (polled.value.state !== 'done') return { kind: 'wait', offline: false };
  const parsed = stepResultSchema.safeParse(polled.value.result);
  return {
    kind: 'end',
    run: parsed.success
      ? { kind: 'done', result: parsed.data }
      : { kind: 'unavailable', why: 'the runner answered a result the server cannot read.' },
  };
}

/**
 * Start `body` on the runner of `threadId` and wait for its result, up to its
 * timeout plus a minute. A stopped run stops the step on the runner.
 */
export async function runStepOnRunner(
  steps: FactoryStepDeps,
  threadId: string,
  body: Record<string, unknown> & { timeoutMs: number },
  signal: AbortSignal,
): Promise<StepRun> {
  const started = await steps.startStep(threadId, body);
  if (started.isErr()) return { kind: 'unavailable', why: `could not start: ${started.error}` };
  const stepId = started.value.stepId;
  const pollMs = steps.pollMs ?? STEP_POLL_MS;
  const graceMs = steps.offlineGraceMs ?? STEP_OFFLINE_GRACE_MS;
  const deadline = Date.now() + body.timeoutMs + 60_000;
  let offlineSince: number | null = null;

  while (Date.now() < deadline) {
    await interruptibleSleep(pollMs, signal).catch(() => undefined);
    if (signal.aborted) break;
    const polled = await steps.pollStep(threadId, stepId);
    const verdict = verdictOf(polled);
    if (verdict.kind === 'end') return verdict.run;
    offlineSince = verdict.offline ? (offlineSince ?? Date.now()) : null;
    if (offlineSince !== null && Date.now() - offlineSince > graceMs && polled.isErr()) {
      return { kind: 'unavailable', why: polled.error };
    }
  }

  await steps.cancelStep?.(threadId, stepId);
  return {
    kind: 'unavailable',
    why: signal.aborted ? 'the run was stopped.' : 'timed out waiting for the step.',
  };
}

const CHANGE_DELTA_TIMEOUT_MS = 2 * 60_000;

/**
 * Ask the runner of `threadId` how the pull request's change differs at `from`
 * and at `to` (openspec factory-approval-survives-integration, D2). Resolves
 * with why it is not available when the runner cannot answer: it is offline,
 * it does not know the step, it lost it, or the commits are not in its
 * checkout. The caller then treats the change as different.
 */
export async function changeDeltaOnRunner(
  steps: FactoryStepDeps,
  threadId: string,
  commits: { from: string; to: string; baseBranch: string; branch: string },
  signal: AbortSignal,
): Promise<Result<ChangeDelta, string>> {
  const run = await runStepOnRunner(
    steps,
    threadId,
    { kind: 'change-delta', ...commits, timeoutMs: CHANGE_DELTA_TIMEOUT_MS },
    signal,
  );
  if (run.kind === 'unavailable') return err(run.why);
  if (run.result.kind !== 'change-delta') return err('the runner answered another step.');
  if (run.result.outcome !== 'compared') return err(run.result.message);
  const { ancestor, lines, files, filesTruncated, outsideFrom } = run.result;
  return ok({ ancestor, lines, files, filesTruncated, outsideFrom });
}
