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
import type { Result } from 'neverthrow';
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
  weave: z.boolean(),
  message: z.string(),
});

const stepResultSchema = z.discriminatedUnion('kind', [commandResultSchema, integrateResultSchema]);

export type CommandStepResult = z.infer<typeof commandResultSchema>;
export type IntegrateStepResult = z.infer<typeof integrateResultSchema>;
export type FactoryStepResult = z.infer<typeof stepResultSchema>;

export type StepRun =
  | { kind: 'done'; result: FactoryStepResult }
  | { kind: 'unavailable'; why: string };

const STEP_POLL_MS = 2_000;
const STEP_OFFLINE_GRACE_MS = 3 * 60_000;

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
    if (polled.isErr()) {
      if (!polled.error.startsWith(RUNNER_UNAVAILABLE_PREFIX)) {
        return {
          kind: 'unavailable',
          why:
            polled.error === 'step-not-found'
              ? 'the runner restarted during the step.'
              : polled.error,
        };
      }
      offlineSince ??= Date.now();
      if (Date.now() - offlineSince > graceMs) return { kind: 'unavailable', why: polled.error };
      continue;
    }
    offlineSince = null;
    if (polled.value.state !== 'done') continue;
    const parsed = stepResultSchema.safeParse(polled.value.result);
    return parsed.success
      ? { kind: 'done', result: parsed.data }
      : { kind: 'unavailable', why: 'the runner answered a result the server cannot read.' };
  }

  await steps.cancelStep?.(threadId, stepId);
  return {
    kind: 'unavailable',
    why: signal.aborted ? 'the run was stopped.' : 'timed out waiting for the step.',
  };
}
