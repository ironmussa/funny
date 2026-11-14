/**
 * Reconciling the factory's state with GitHub and the workspaces on start
 * (#288), so that stopping the orchestrator, even abruptly, never loses a
 * factory run or starts a second one for its issue.
 *
 * - A step the previous process left running for the run is stopped first,
 *   so it cannot push or open a pull request next to the retry.
 * - Interrupted before its pull request (`queued`, `claiming`, `working`): if
 *   GitHub has an open pull request from the run's branch (it stopped right
 *   after opening it), the run adopts it, with the agent session its step
 *   recorded, and waits for CI; otherwise its pushed branch, if any, is
 *   deleted and the interruption is an infrastructure failure that follows
 *   the retry rule. If GitHub cannot be asked, it is asked again on the next
 *   tick: a retry never opens a second pull request.
 * - Interrupted in a fix (`fixing`): an infrastructure failure; it waits for CI
 *   again, without using up a fix attempt.
 * - Waiting on its pull request (`waiting_ci`, `merging`, `ready`): merged
 *   while the factory was down → cleanup and `merged`; closed → `failed`; its
 *   workspace gone (`waiting_ci`) → an infrastructure failure; else
 *   it looks at the pull request on the next tick.
 */

import type { FactoryRun } from '../ports/run-store.js';
import type { FactoryProject } from '../settings/schema.js';
import { prNumberOf, type FactoryContext } from './context.js';
import type { Failures } from './failures.js';
import { createMergeFollowUp } from './merge.js';

const INTERRUPTED = 'interrupted by a restart of the factory';

export function createReconciliation(ctx: FactoryContext, failures: Failures) {
  const { runs, clock } = ctx;
  const merge = createMergeFollowUp(ctx, failures);
  const now = () => clock.now().toISOString();

  /** Before its pull request: adopt one GitHub has, else retry. */
  async function beforePullRequest(project: FactoryProject, run: FactoryRun): Promise<FactoryRun> {
    if (run.state === 'queued') {
      // Never started (or waiting to retry): it starts when due, as it would have.
      return run.notBefore ? run : runs.update(run, { notBefore: now() });
    }
    if (!run.branch) return failures.onInfraFailure(run, INTERRUPTED);
    const found = await ctx.pullRequests.findOpen(run.repo, run.branch);
    if (found.isErr()) {
      return runs.update(run, {
        reason: `${INTERRUPTED}; checking GitHub again: ${found.error.message}`,
      });
    }
    if (found.value) return adopt(project, run, found.value);
    // Pushed without a pull request: the retry starts on a new branch, this one goes.
    const deleted = await ctx.pullRequests.deleteBranch(run.repo, run.branch);
    if (deleted.isErr()) {
      return runs.update(run, {
        reason: `${INTERRUPTED}; checking GitHub again: ${deleted.error.message}`,
      });
    }
    return failures.onInfraFailure(run, INTERRUPTED);
  }

  /** The pull request the interrupted step opened becomes the run's. */
  async function adopt(project: FactoryProject, run: FactoryRun, prUrl: string) {
    const sessionId =
      run.sessionId ?? (await ctx.workspaces.lastSessionId(ctx.workspaceRequest(run, project)));
    const working = run.state === 'working' ? run : runs.transition(run, 'working');
    const opened = runs.transition(working, 'pr_open', { prUrl, sessionId, pushedAt: now() });
    return runs.transition(opened, 'waiting_ci', { ...ctx.waitingForCi(), infraRetries: 0 });
  }

  /** Waiting on its pull request: what happened to it while the factory was down. */
  async function waiting(project: FactoryProject, run: FactoryRun): Promise<FactoryRun> {
    const pr = await ctx.pullRequests.mergeState(run.repo, prNumberOf(run.prUrl));
    if (pr.isErr()) return runs.update(run, { nextCheckAt: now() });
    if (pr.value.state === 'merged') return merge.cleanUp(project, run);
    if (pr.value.state === 'closed') {
      return failures.giveUp(run, 'the pull request was closed without merging');
    }
    // Only a run waiting for CI may need its checkout again (for a fix).
    if (run.state === 'waiting_ci' && !ctx.workspaces.exists(ctx.workspaceRequest(run, project))) {
      return failures.onInfraFailure(run, 'the workspace disappeared', 'waiting_ci');
    }
    return runs.update(run, { nextCheckAt: now() });
  }

  /** Put one run a previous process (or this one, earlier) left behind back on track. */
  async function reconcileRun(project: FactoryProject, run: FactoryRun): Promise<FactoryRun> {
    await ctx.workspaces.stopLeftovers(ctx.workspaceRequest(run, project));
    switch (run.state) {
      case 'queued':
      case 'claiming':
      case 'working':
        return beforePullRequest(project, run);
      case 'pr_open':
        return runs.transition(run, 'waiting_ci', { nextCheckAt: now(), reason: 'waiting for CI' });
      case 'fixing':
        return failures.onInfraFailure(run, INTERRUPTED, 'waiting_ci');
      case 'waiting_ci':
      case 'merging':
      case 'ready':
        return waiting(project, run);
      default:
        return run;
    }
  }

  /** Reconcile every run of a watched project, one at a time. */
  async function reconcileAll(projects: FactoryProject[]): Promise<void> {
    for (const run of ctx.store.list()) {
      const project = projects.find((p) => p.repo === run.repo);
      if (project) await reconcileRun(project, run);
    }
  }

  return { reconcileAll, reconcileRun };
}
