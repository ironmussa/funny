/**
 * How a factory run ends when it does not make it, and how an infrastructure
 * failure is retried (#287): the configured delay, then twice that, at most
 * twice; then, as for an agent failure, the run fails and its issue is
 * handed back (a comment with the reason, the ready and in-progress labels
 * removed). Until the hand-back has gone through, the issue is not admitted
 * again.
 */

import { MAX_INFRA_RETRIES, nextInfraRetry } from '../domain/retry-policy.js';
import type { FailureKind } from '../domain/step-outcome.js';
import type { FactoryRun } from '../ports/run-store.js';
import type { FactoryContext } from './context.js';

/** Where an infrastructure failure is retried: before the pull request, or after it. */
export type RetryState = 'queued' | 'waiting_ci';

const handBackComment = (runId: string, reason: string, label: string) =>
  `The issue factory could not finish this issue (run \`${runId}\`): ${reason}\n\nIts branch and pull request, if any, are kept. Add the \`${label}\` label again to start a new factory run.`;

export interface Failures {
  /** Give the issue back: a comment with the reason, the ready and in-progress labels removed. */
  handBack(run: FactoryRun): Promise<FactoryRun>;
  /** The end of a factory run that did not make it: `failed`, and the issue handed back. */
  giveUp(run: FactoryRun, reason: string): Promise<FactoryRun>;
  /**
   * An infrastructure failure: tried again later; once the retries are used
   * up, the run fails. Before the pull request the run starts over
   * (`queued`); after it, its pull request is looked at again (`waiting_ci`).
   */
  onInfraFailure(
    run: FactoryRun,
    reason: string,
    retryIn?: RetryState,
  ): FactoryRun | Promise<FactoryRun>;
  /** A failed step: an agent failure ends the run, an infrastructure one is retried. */
  onStepFailed(
    run: FactoryRun,
    outcome: { failure: FailureKind; reason: string },
    retryIn?: RetryState,
  ): FactoryRun | Promise<FactoryRun>;
}

export function createFailures(ctx: FactoryContext): Failures {
  const { runs, settings, clock, log } = ctx;

  async function handBack(run: FactoryRun): Promise<FactoryRun> {
    const back = await ctx.issues.handBack(run.repo, run.issueNumber, {
      readyLabel: settings.labels.ready,
      inProgressLabel: settings.labels.in_progress,
      comment: handBackComment(run.id, run.reason ?? 'unknown reason', settings.labels.ready),
    });
    if (back.isErr()) {
      // Tried again on the next tick; until then the issue is not admitted again.
      log.warn('Could not hand the issue back', { run: run.id, error: back.error.message });
      return run;
    }
    return runs.update(run, { handedBackAt: clock.now().toISOString() });
  }

  const giveUp = (run: FactoryRun, reason: string) =>
    handBack(
      runs.transition(run, 'failed', { reason, notBefore: undefined, nextCheckAt: undefined }),
    );

  function onInfraFailure(run: FactoryRun, reason: string, retryIn: RetryState = 'queued') {
    const retries = run.infraRetries ?? 0;
    const at = nextInfraRetry(retries, settings.retry_delay_minutes, clock.now());
    if (!at) {
      return giveUp(run, `infra failure (after ${MAX_INFRA_RETRIES} retries): ${reason}`);
    }
    const when = at.toISOString();
    const change: Partial<FactoryRun> = {
      infraRetries: retries + 1,
      reason: `infra failure: ${reason}; retrying after ${when}`,
    };
    if (retryIn === 'queued') return runs.transition(run, 'queued', { ...change, notBefore: when });
    // Reading the pull request failed: look again later, in the same state.
    if (run.state !== 'fixing') return runs.update(run, { ...change, nextCheckAt: when });
    // A fix that could not run: it was no attempt at fixing CI.
    return runs.transition(run, 'waiting_ci', {
      ...change,
      nextCheckAt: when,
      fixAttempts: Math.max(0, (run.fixAttempts ?? 1) - 1),
    });
  }

  const onStepFailed: Failures['onStepFailed'] = (run, outcome, retryIn = 'queued') =>
    outcome.failure === 'agent'
      ? giveUp(run, `agent failure: ${outcome.reason}`)
      : onInfraFailure(run, outcome.reason, retryIn);

  return { handBack, giveUp, onInfraFailure, onStepFailed };
}
