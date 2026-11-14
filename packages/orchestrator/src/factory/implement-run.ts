/**
 * A factory run from its claim to its draft pull request: claim the issue
 * (assign, labels, one comment), read the base and the issue's trusted text,
 * prepare the workspace and run the `implement` step.
 */

import type { TrustedIssue } from '../ports/issue-source.js';
import type { FactoryRun } from '../ports/run-store.js';
import type { FactoryProject } from '../settings/schema.js';
import type { FactoryContext } from './context.js';
import type { Failures } from './failures.js';

const claimComment = (runId: string) =>
  `The issue factory is working on this issue (run \`${runId}\`). It will open a draft pull request that closes it.`;

export function createImplementRun(ctx: FactoryContext, failures: Failures) {
  const { runs, settings, clock } = ctx;
  const { onInfraFailure, onStepFailed } = failures;

  /**
   * What the `implement` step needs: the base branch and the issue's trusted
   * text; the run records them and its branch. A failure is returned as the
   * run it left behind.
   */
  async function startWork(
    project: FactoryProject,
    working: FactoryRun,
  ): Promise<FactoryRun | { run: FactoryRun; trusted: TrustedIssue; base: string }> {
    const base = project.base ?? (await ctx.issues.defaultBranch(working.repo).unwrapOr(null));
    if (!base) return onInfraFailure(working, 'could not read the repository default branch');
    const trusted = await ctx.issues.readTrusted(
      working.repo,
      working.issueNumber,
      settings.github.login,
    );
    if (trusted.isErr()) {
      return onInfraFailure(working, `could not read the issue: ${trusted.error.message}`);
    }
    // Each attempt has its own branch: an earlier one may have pushed before it failed.
    const retry = working.infraRetries ? `-retry${working.infraRetries}` : '';
    const run = runs.update(working, {
      base,
      branch: `factory/issue-${working.issueNumber}-${working.id.slice(-8)}${retry}`,
      issueTitle: trusted.value.title,
    });
    return { run, trusted: trusted.value, base };
  }

  /** From claiming the issue to the pull request of its `implement` step. */
  return async function implementIssue(
    project: FactoryProject,
    queued: FactoryRun,
  ): Promise<FactoryRun> {
    let run = runs.transition(queued, 'claiming');
    const claimed = await ctx.issues.claim(run.repo, run.issueNumber, {
      login: settings.github.login,
      readyLabel: settings.labels.ready,
      inProgressLabel: settings.labels.in_progress,
      // Commented once: a retry of a completed claim does not comment again.
      comment: queued.claimedAt ? undefined : claimComment(run.id),
    });
    if (claimed.isErr()) {
      return onInfraFailure(run, `could not claim the issue: ${claimed.error.message}`);
    }
    if (!run.claimedAt) run = runs.update(run, { claimedAt: clock.now().toISOString() });

    const working = await startWork(project, runs.transition(run, 'working'));
    if (!('trusted' in working)) return working;
    run = working.run;
    const { trusted, base } = working;

    const workspace = await ctx.workspaces.prepare(ctx.workspaceRequest(run, project));
    if (workspace.isErr()) {
      return onInfraFailure(run, `could not prepare the workspace: ${workspace.error}`);
    }
    try {
      const outcome = await workspace.value.implement({
        runId: run.id,
        issue: trusted,
        base,
        branch: run.branch!,
        checkCommand: project.check,
        author: settings.github.author,
        model: settings.model,
      });
      if (outcome.kind === 'failed') return onStepFailed(run, outcome);
      if (outcome.kind !== 'pr_opened') {
        return onInfraFailure(run, 'the step opened no pull request');
      }
      run = runs.transition(run, 'pr_open', {
        prUrl: outcome.prUrl,
        sessionId: outcome.sessionId,
        pushedAt: clock.now().toISOString(),
        // A new phase: retries of infrastructure failures start over.
        infraRetries: 0,
      });
      return runs.transition(run, 'waiting_ci', ctx.waitingForCi());
    } finally {
      await workspace.value.release();
    }
  };
}
