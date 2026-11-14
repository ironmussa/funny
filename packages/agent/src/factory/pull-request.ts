/**
 * A factory run after its pull request opened (#285): every 3 minutes it
 * reads the pull request's CI. Green marks it ready for review (`ready`); a
 * failing check or a conflict runs the `fix` step with the same agent session
 * (`fixing`, at most `MAX_FIX_ATTEMPTS` times); no check reported for long
 * means the repository has no CI.
 */

import { MAX_FIX_ATTEMPTS } from '../domain/factory-run.js';
import type { CiState } from '../ports/pull-request-ci.js';
import type { FactoryRun } from '../ports/run-store.js';
import type { FactoryProject } from '../settings/schema.js';
import type { FixStepSpec } from '../steps/fix.js';
import { prNumberOf, READY_POLL_MS, type FactoryContext } from './context.js';
import type { Failures } from './failures.js';
import { createMergeFollowUp } from './merge.js';

/** With no check reported this long after a push, the repository has no CI. */
const NO_CI_GRACE_MS = 15 * 60 * 1000;

export function createPullRequestFollowUp(ctx: FactoryContext, failures: Failures) {
  const { runs, settings, clock } = ctx;
  const { giveUp, onInfraFailure, onStepFailed } = failures;
  const merge = createMergeFollowUp(ctx, failures);

  /** A `fix` step for a failing check or a conflict, in the run's own checkout. */
  async function fixRun(
    project: FactoryProject,
    fixing: FactoryRun,
    problem: FixStepSpec['problem'],
  ): Promise<FactoryRun> {
    if (!fixing.sessionId) return giveUp(fixing, 'infra failure: no agent session to resume');
    const workspace = await ctx.workspaces.reopen(ctx.workspaceRequest(fixing, project));
    if (workspace.isErr()) {
      return onInfraFailure(
        fixing,
        `could not reopen the workspace: ${workspace.error}`,
        'waiting_ci',
      );
    }
    try {
      const outcome = await workspace.value.fix({
        runId: fixing.id,
        sessionId: fixing.sessionId,
        issue: {
          number: fixing.issueNumber,
          title: fixing.issueTitle ?? `Issue #${fixing.issueNumber}`,
        },
        prUrl: fixing.prUrl!,
        base: fixing.base!,
        branch: fixing.branch!,
        checkCommand: project.check,
        author: settings.github.author,
        model: settings.model,
        problem,
      });
      // An agent that could not fix it has used up an attempt; CI is looked at again.
      if (outcome.kind === 'failed' && outcome.failure === 'agent') {
        return runs.transition(
          fixing,
          'waiting_ci',
          ctx.waitingForCi(`last fix: ${outcome.reason}`),
        );
      }
      if (outcome.kind === 'failed') return onStepFailed(fixing, outcome, 'waiting_ci');
      return runs.transition(fixing, 'waiting_ci', {
        ...ctx.waitingForCi(),
        sessionId: outcome.sessionId ?? fixing.sessionId,
        pushedAt: clock.now().toISOString(),
        // A new phase: retries of infrastructure failures start over.
        infraRetries: 0,
      });
    } finally {
      await workspace.value.release();
    }
  }

  /** What a red pull request gets: a fix if attempts and a slot are left. */
  function onRed(
    project: FactoryProject,
    run: FactoryRun,
    ci: Extract<CiState, { kind: 'failing' | 'conflict' }>,
  ) {
    const attempts = run.fixAttempts ?? 0;
    if (attempts >= MAX_FIX_ATTEMPTS) {
      return giveUp(run, `agent failure: CI did not pass after ${MAX_FIX_ATTEMPTS} fix attempts`);
    }
    // Checked and taken without awaiting, so two follow-ups cannot take one slot.
    if (ctx.slotsLeft() <= 0) {
      return runs.update(run, ctx.waitingForCi('waiting for a free slot to fix CI'));
    }
    const [problem, reason]: [FixStepSpec['problem'], string] =
      ci.kind === 'conflict'
        ? [{ kind: 'conflict' }, 'fixing a conflict with the base']
        : [{ kind: 'checks', checks: ci.checks }, 'fixing failing checks'];
    const fixing = runs.transition(run, 'fixing', { fixAttempts: attempts + 1, reason });
    return fixRun(project, fixing, problem);
  }

  /** Take the pull request out of draft without merging (no CI to wait for). */
  async function markReadyWithoutCi(run: FactoryRun, number: number) {
    const marked = await ctx.pullRequests.markReady(run.repo, number);
    if (marked.isErr()) {
      return onInfraFailure(run, `could not mark it ready: ${marked.error.message}`, 'waiting_ci');
    }
    // Never merged by the factory: nothing has checked it.
    return runs.transition(run, 'ready', {
      reason: 'no CI reported any check; marked ready without CI',
      nextCheckAt: ctx.later(READY_POLL_MS),
      infraRetries: 0,
    });
  }

  /** No check reported: CI may not have started, or the repository has none. */
  function onNoChecks(run: FactoryRun, number: number) {
    const pushedAt = Date.parse(run.pushedAt ?? run.updatedAt);
    if (clock.now().getTime() - pushedAt < NO_CI_GRACE_MS) {
      return runs.update(run, ctx.waitingForCi('waiting for CI to report a check'));
    }
    return markReadyWithoutCi(run, number);
  }

  /** One look at a waiting run's pull request. */
  async function followCi(project: FactoryProject, run: FactoryRun): Promise<FactoryRun> {
    const number = prNumberOf(run.prUrl);
    const ci = await ctx.pullRequests.ciState(run.repo, number);
    if (ci.isErr()) {
      return onInfraFailure(run, `could not read the CI: ${ci.error.message}`, 'waiting_ci');
    }
    switch (ci.value.kind) {
      case 'pending':
        return runs.update(run, ctx.waitingForCi());
      case 'none':
        return onNoChecks(run, number);
      case 'green':
        return merge.onGreen(project, run);
      default:
        return onRed(project, run, ci.value);
    }
  }

  /** The next look at a run's pull request, by the state it waits in. */
  return function followPullRequest(project: FactoryProject, run: FactoryRun) {
    return run.state === 'waiting_ci' ? followCi(project, run) : merge.follow(project, run);
  };
}
