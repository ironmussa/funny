/**
 * A factory run whose pull request is green (#286).
 *
 * With auto-merge on, the factory enables GitHub's auto-merge (`merging`):
 * GitHub merges once the branch protections are met (required reviews and
 * checks still apply; nothing is bypassed). Every 3 minutes the factory looks:
 * merged → its workspace and remote branch are removed, then `merged`; closed →
 * `failed`, handed back; red again (a conflict, a failing check) → back to
 * `waiting_ci` for a fix; auto-merge turned off (a push, a person) while still
 * green → enabled again. `merging` holds no concurrency slot.
 *
 * With auto-merge off the pull request is only marked ready (`ready`); if a
 * person merges it later, the factory sees it (every 30 minutes) and cleans up
 * the same way.
 */

import type { AutoMergeResult } from '../ports/pull-request-ci.js';
import type { FactoryRun } from '../ports/run-store.js';
import type { FactoryProject } from '../settings/schema.js';
import { prNumberOf, READY_POLL_MS, type FactoryContext } from './context.js';
import type { Failures } from './failures.js';

export function createMergeFollowUp(ctx: FactoryContext, failures: Failures) {
  const { runs, log } = ctx;
  const { giveUp, onInfraFailure } = failures;

  /** Ready for review, not merged by the factory (a new phase: retries start over). */
  const ready = (run: FactoryRun, reason: string | null) =>
    runs.transition(run, 'ready', {
      reason,
      nextCheckAt: ctx.later(READY_POLL_MS),
      infraRetries: 0,
    });

  /**
   * The pull request merged: its workspace and remote branch go, then the run
   * is `merged`. What could not be removed is tried again on the next look.
   */
  async function cleanUp(project: FactoryProject, run: FactoryRun): Promise<FactoryRun> {
    const problems: string[] = [];
    const removed = await ctx.workspaces.remove(ctx.workspaceRequest(run, project));
    if (removed.isErr()) problems.push(removed.error);
    const deleted = await ctx.pullRequests.deleteBranch(run.repo, run.branch ?? '');
    if (deleted.isErr()) problems.push(deleted.error.message);
    if (problems.length === 0) {
      return runs.transition(run, 'merged', { reason: null, nextCheckAt: undefined });
    }
    log.warn('Could not clean up after a merge', { run: run.id, error: problems.join('; ') });
    const retrying = {
      reason: `merged; cleanup incomplete, retrying: ${problems.join('; ')}`,
      nextCheckAt: ctx.later(),
    };
    // Followed as a merge from now on, never as a pull request waiting for CI.
    return run.state === 'waiting_ci'
      ? runs.transition(run, 'merging', retrying)
      : runs.update(run, retrying);
  }

  /** What enabling auto-merge leaves; `from` is the state the run is in now. */
  function afterAutoMerge(project: FactoryProject, run: FactoryRun, result: AutoMergeResult) {
    const merging = (reason: string) =>
      run.state === 'merging'
        ? runs.update(run, { reason, nextCheckAt: ctx.later() })
        : runs.transition(run, 'merging', { reason, nextCheckAt: ctx.later(), infraRetries: 0 });
    switch (result.kind) {
      case 'unavailable':
        return run.state === 'merging'
          ? merging(`not merged: ${result.reason}`)
          : ready(run, `not merged: ${result.reason}`);
      case 'not-mergeable':
        return merging(`waiting until GitHub can merge it: ${result.reason}`);
      case 'merged':
        return cleanUp(project, merging('merged'));
      default:
        return merging(`auto-merge (${result.method}) enabled; waiting for GitHub to merge`);
    }
  }

  async function enableAutoMerge(project: FactoryProject, run: FactoryRun) {
    const merge = await ctx.pullRequests.enableAutoMerge(run.repo, prNumberOf(run.prUrl));
    if (merge.isErr()) {
      return onInfraFailure(
        run,
        `could not enable auto-merge: ${merge.error.message}`,
        'waiting_ci',
      );
    }
    return afterAutoMerge(project, run, merge.value);
  }

  /** Green CI: ready for review, and with auto-merge on, merging through GitHub. */
  async function onGreen(project: FactoryProject, run: FactoryRun): Promise<FactoryRun> {
    const marked = await ctx.pullRequests.markReady(run.repo, prNumberOf(run.prUrl));
    if (marked.isErr()) {
      return onInfraFailure(run, `could not mark it ready: ${marked.error.message}`, 'waiting_ci');
    }
    return ctx.settings.auto_merge ? enableAutoMerge(project, run) : ready(run, null);
  }

  /** While it waits to merge: back to the fix loop if red, auto-merge again if it was turned off. */
  async function whileMerging(project: FactoryProject, run: FactoryRun, autoMerge: boolean) {
    const ci = await ctx.pullRequests.ciState(run.repo, prNumberOf(run.prUrl));
    if (ci.isOk() && (ci.value.kind === 'conflict' || ci.value.kind === 'failing')) {
      return runs.transition(run, 'waiting_ci', {
        nextCheckAt: ctx.clock.now().toISOString(),
        reason: 'the pull request turned red while waiting to merge',
      });
    }
    if (ci.isOk() && ci.value.kind === 'green' && !autoMerge) return enableAutoMerge(project, run);
    return runs.update(run, { nextCheckAt: ctx.later() });
  }

  /** One look at a `merging` or `ready` run's pull request. */
  async function follow(project: FactoryProject, run: FactoryRun): Promise<FactoryRun> {
    const pr = await ctx.pullRequests.mergeState(run.repo, prNumberOf(run.prUrl));
    if (pr.isErr()) {
      return onInfraFailure(
        run,
        `could not read the pull request: ${pr.error.message}`,
        'waiting_ci',
      );
    }
    if (pr.value.state === 'merged') return cleanUp(project, run);
    if (pr.value.state === 'closed')
      return giveUp(run, 'the pull request was closed without merging');
    if (run.state === 'ready') return runs.update(run, { nextCheckAt: ctx.later(READY_POLL_MS) });
    return whileMerging(project, run, pr.value.autoMerge);
  }

  return { onGreen, follow, cleanUp };
}
