/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * How a factory run's flow ends (see `factory-flow-runs.ts`'s module comment):
 * the run is dropped, failed, parked for its member (who is told), or done.
 */

import { log } from '../../lib/logger.js';
import { sendPush } from '../web-push.js';
import {
  failureReason,
  flowOf,
  subjectOf,
  wasReopened,
  type FactoryFlowRunsDeps,
  type FactoryRunJob,
  type FlowTrace,
} from './factory-flow-runs-model.js';
import type { FactoryFlowError } from './factory-flow.js';
import { threadsOf } from './factory-runs.js';

/** The ends of a run's flow, bound to the host's dependencies. */
export function createFlowSettlement(deps: FactoryFlowRunsDeps) {
  /** A run whose flow could not be loaded: dropped when it never ran, failed when invalid. */
  async function flowUnavailable(job: FactoryRunJob, error: FactoryFlowError): Promise<void> {
    log.warn('Issue factory flow could not be loaded', {
      namespace: 'factory',
      factoryId: job.factory.id,
      runId: job.run.id,
      flow: flowOf(job),
      kind: error.kind,
      error: error.message,
    });
    await deps.reportBlocked?.(
      job.factory.id,
      `The flow "${flowOf(job)}" could not be loaded: ${error.message}`,
    );
    if (error.kind === 'invalid') {
      await deps.runs.updateInFlight(job.run.id, {
        state: 'failed',
        currentStep: null,
        failureReason: `The flow "${flowOf(job)}" could not be loaded: ${error.message}`,
      });
    } else if (job.run.threadIds.length === 0 && !wasReopened(job)) {
      // A run that never ran is dropped (a sent one goes back in line); a
      // retried one stays queued for a later tick.
      await forgetUnstarted(job);
    }
  }

  /** A run that never started an agent: a sent issue goes back in line, a label run is dropped. */
  async function forgetUnstarted(job: FactoryRunJob): Promise<void> {
    // What a person sent or started waits in line; a labelled issue is found
    // again, and a scheduled occurrence that could not start is not run late.
    if (job.run.source === 'manual' || job.run.source === 'run_now') {
      await deps.runs.requeue(job.run.id);
    } else await deps.runs.remove(job.run.id);
  }

  const notify = deps.notify ?? sendPush;

  /** Tell the enabler their run waits for them; best-effort. */
  async function noticeWaiting(job: FactoryRunJob, why: string): Promise<void> {
    await notify(job.factory.userId, {
      title: `${subjectOf(job)} needs you`,
      body: why.length > 200 ? `${why.slice(0, 199)}…` : why,
      url: `/projects/${job.factory.projectId}`,
      tag: `factory-run-${job.run.id}`,
    }).catch((error: unknown) =>
      log.warn('Issue factory notification failed', {
        namespace: 'factory',
        runId: job.run.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /**
   * Leave the run for the member — completed without a merge, or failed (at
   * `failedStep`) with its pull request open — and tell them.
   */
  async function park(job: FactoryRunJob, failedStep: string | null, error?: string) {
    const parked = await deps.runs.updateInFlight(job.run.id, {
      state: 'waiting_human',
      currentStep: failedStep,
      failureReason: failedStep ? failureReason(error) : null,
    });
    if (parked.isErr() || !parked.value) return;
    const why = failedStep
      ? `The ${failedStep} step failed: ${error ?? ''}`.trim()
      : 'Its pull request is ready.';
    await noticeWaiting(job, why);
  }

  /** A run whose agent never started (e.g. the runner is offline): not an attempt, but say why. */
  async function dropUnstarted(job: FactoryRunJob, error?: string): Promise<void> {
    await forgetUnstarted(job);
    await deps.reportBlocked?.(
      job.factory.id,
      `${subjectOf(job)} could not start: ${error ?? 'unknown error'}`,
    );
  }

  /** Record the flow's end in the run (see the module comment). */
  /** The run merged: clean its threads' worktrees up without holding the flow. */
  function cleanUpMerged(job: FactoryRunJob): void {
    if (!deps.cleanupMerged) return;
    const cleanup = deps.cleanupMerged;
    void deps.runs.get(job.run.id).match(
      (run) => cleanup(job.factory.userId, threadsOf(run ?? job.run)),
      () => cleanup(job.factory.userId, threadsOf(job.run)),
    );
  }

  /** A flow that failed: dropped before any agent ran, left as a step parked it, failed, or parked. */
  async function settleFailed(job: FactoryRunJob, trace: FlowTrace, error?: string): Promise<void> {
    const { run } = job;
    // Triage parked it on its issue or sent it back to the queue: nothing to settle.
    if (trace.held) return;
    // The step wrote the run's end: not a failure, and nobody is waited for.
    if (trace.ended) return;
    if (!trace.agentsRan && !wasReopened(job)) return dropUnstarted(job, error);
    if (trace.parked) {
      await deps.runs.updateInFlight(run.id, { currentStep: trace.step });
      await noticeWaiting(job, error ?? 'It waits for you.');
      return;
    }
    if (trace.prOpen) {
      await park(job, trace.step, error);
      return;
    }
    await deps.runs.updateInFlight(run.id, {
      state: 'failed',
      currentStep: trace.step,
      failureReason: failureReason(error),
    });
  }

  async function settle(
    job: FactoryRunJob,
    outcome: 'completed' | 'failed' | 'cancelled',
    trace: FlowTrace,
    error?: string,
  ): Promise<void> {
    const { run } = job;
    if (outcome === 'cancelled') return;
    if (outcome === 'failed') await settleFailed(job, trace, error);
    // A run without an issue that opened no pull request has nothing left to follow.
    else if (job.issue === null && !trace.prOpen) {
      await deps.runs.updateInFlight(run.id, { state: 'done', currentStep: null });
    } else await park(job, null, error);
    log.info('Issue factory run ended', {
      namespace: 'factory',
      factoryId: job.factory.id,
      runId: run.id,
      issue: run.issueNumber,
      outcome: trace.ended ? 'no_change' : outcome,
      error,
    });
  }
  return { flowUnavailable, cleanUpMerged, settle };
}
