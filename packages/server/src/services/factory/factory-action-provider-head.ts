/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * What the factory's `ActionProvider` (`factory-action-provider.ts`) does
 * with the run's pull request and checkout outside the merge gate: classing
 * its head commit, publishing review verdicts, finding the pull request the
 * agent opened (or ending the run with no change), and `run_command`.
 */

import {
  contractOf,
  reviewAllowsMerge,
  type FactoryReviewVerdict,
  type FactoryRisk,
  type FactoryTriage,
} from '@funny/shared/contracts/factory';
import type { ActionResult, RunCommandOpts } from '@funny/workflows/compiler';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import type { ClassifiedHead, ProviderContext } from './factory-action-provider-deps.js';
import { reviewComment, reviewHeadline } from './factory-review.js';
import { classifyRisk } from './factory-risk.js';
import { runStepOnRunner } from './factory-step-runner.js';
import { checkTestWeakening } from './factory-test-weakening.js';
import type { KeptWorktree } from './factory-thread-requests.js';

/**
 * Why a run without a commit or a pull request waits for a person: its checkout
 * held unsaved work, so the agent may not have meant "nothing to change".
 */
export const NO_CHANGE_REASON = 'no change';

/** The fixed first line of the issue comment a "no change" run posts. */
export const NO_CHANGE_LINE = 'The issue factory made no change for this issue. The agent said:';

/** How many changed paths a risk record keeps (the merge queue compares them, D11). */
const MAX_RECORDED_PATHS = 300;

/** A factory step's timeout when the flow sets none: 10 minutes. */
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;

export const refused = (step: string, why: string): ActionResult => ({
  ok: false,
  error: `${step} is not available in a factory flow: ${why}`,
});

/** What a "no change" comment says about a checkout that was kept. */
function keptWorktreeLine(kept: KeptWorktree): string {
  const parts = [
    kept.dirtyFileCount > 0 ? `${kept.dirtyFileCount} uncommitted file(s)` : null,
    kept.unpushedCommitCount > 0 ? `${kept.unpushedCommitCount} unpushed commit(s)` : null,
  ].filter(Boolean);
  const what = parts.length > 0 ? parts.join(' and ') : 'work that could not be checked';
  return `The run's checkout was kept because it holds ${what}: \`${kept.worktreePath}\`.`;
}

/** The enabler reads the repository: the App token capped by their access. */
export function readerOf(ctx: ProviderContext) {
  const { scope } = ctx;
  return { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId };
}

/** The pull request's head commit: its weakened tests, its risk class, and the published verdicts. */
export function createHeadChecks(ctx: ProviderContext, triage: () => FactoryTriage | null) {
  const { deps, scope, state } = ctx;

  /**
   * Check the pull request's head commit for weakened tests and class its risk,
   * once per commit, and store the class on the run. A change that cannot be
   * read is high risk: what was not read was not checked.
   */
  async function classifyHead(): Promise<ClassifiedHead | null> {
    const pr = ctx.pullRequest();
    if (!pr) return null;
    const head = await deps.github.pullRequests.pullHead(pr);
    if (head.isErr()) return null;
    const sha = head.value.sha;
    if (state.classified?.sha === sha) return state.classified;
    const files = await deps.github.pullRequests.changedFiles(pr);
    const findings = files.isOk() ? checkTestWeakening(files.value) : [];
    const risk: FactoryRisk = files.isOk()
      ? classifyRisk({
          headSha: sha,
          change: files.value,
          findings,
          sensitivePaths: deps.sensitivePaths,
          maxLowRiskLines: deps.maxLowRiskLines,
          sizeIgnoredPaths: deps.sizeIgnoredPaths,
          riskHints: contractOf({ triage: triage() })?.riskHints,
        })
      : {
          headSha: sha,
          level: 'high',
          reasons: [`the change could not be read: ${files.error.message}`],
        };
    if (files.isOk()) {
      risk.changedLines = files.value.files.reduce((n, f) => n + f.additions + f.deletions, 0);
      risk.paths = files.value.files.slice(0, MAX_RECORDED_PATHS).map((f) => f.path);
      deps.onChangeSize?.(risk.changedLines);
    }
    const classified = { sha, findings, risk };
    state.classified = classified;
    await deps.record({ risk });
    metric('factory.integration_event', 1, {
      type: 'sum',
      attributes: { event: `risk_${risk.level}`, repo: scope.repo },
    });
    return classified;
  }

  /**
   * Put a verdict on the run's pull request. Best effort: a failure is logged
   * and counted, and the verdict the run stored still decides the merge.
   */
  async function publishVerdict(verdict: FactoryReviewVerdict) {
    const pr = ctx.pullRequest();
    if (!pr) return { comment: false, status: false };
    const published = await deps.github.pullRequests.publishReview(pr, {
      sha: verdict.sha,
      allowsMerge: reviewAllowsMerge(verdict),
      body: reviewComment(verdict),
      description: reviewHeadline(verdict),
    });
    if (published.isOk()) return { comment: true, status: published.value.status };
    log.warn('Issue factory could not publish the review verdict', {
      namespace: 'factory',
      runId: scope.runId,
      sha: verdict.sha,
      error: published.error.message,
    });
    metric('factory.integration_event', 1, {
      type: 'sum',
      attributes: { event: 'review_unpublished', repo: scope.repo },
    });
    return { comment: false, status: false };
  }

  /** The `funny/review` status of a verdict carried to a base-merge commit (best effort). */
  async function publishCarriedStatus(verdict: FactoryReviewVerdict): Promise<boolean> {
    const pr = ctx.pullRequest();
    if (!pr) return false;
    const from = verdict.carriedFrom ? ` (kept from ${verdict.carriedFrom.slice(0, 8)})` : '';
    const published = await deps.github.pullRequests.publishReview(pr, {
      sha: verdict.sha,
      allowsMerge: reviewAllowsMerge(verdict),
      description: `${reviewHeadline(verdict)}${from}`.slice(0, 140),
    });
    return published.isOk() && published.value.status;
  }

  return { classifyHead, publishVerdict, publishCarriedStatus };
}

/** Say the no-change outcome on the issue; a comment that fails is logged, not fatal. */
async function commentNoChange(
  ctx: ProviderContext,
  issueNumber: number,
  body: string,
): Promise<void> {
  const commented = await ctx.deps.github.commentOnIssue(readerOf(ctx), issueNumber, body);
  if (commented.isOk()) return;
  log.warn('Issue factory could not comment a no-change outcome on the issue', {
    namespace: 'factory',
    runId: ctx.scope.runId,
    issue: issueNumber,
    error: commented.error.message,
  });
}

/**
 * The agent pushed no commit and opened no pull request: say so on the issue
 * with its explanation and remove the run's checkout. Not ok, so the flow
 * stops here.
 *
 * With nothing left behind, the agent decided there is nothing to change: the
 * run ends as `no_change` (not a failure) and the issue goes back to a person
 * for triage. The issue is not closed: "nothing to change" is the agent's
 * opinion (an index issue is not done; a bug may not really be fixed).
 *
 * A checkout with uncommitted files or unpushed commits is kept and named in
 * the comment, and the run waits for a person (`waiting_human`, reason `no
 * change`): the agent may have stopped before committing (issue #229 lost 85
 * edited files this way).
 */
async function noChange(ctx: ProviderContext): Promise<ActionResult> {
  const { deps, scope, state } = ctx;
  const threadId = state.threadIds[0];
  const explanation = threadId ? await deps.lastThreadMessage?.(threadId) : null;
  const kept = (await deps.removeUnchangedWorktrees?.()) ?? [];
  const body = [NO_CHANGE_LINE, explanation, ...kept.map(keptWorktreeLine)]
    .filter(Boolean)
    .join('\n\n');
  // A run without an issue has none to comment on or hand back: with nothing kept, it is done.
  if (scope.issueNumber !== null) await commentNoChange(ctx, scope.issueNumber, body);
  if (kept.length > 0) {
    await deps.record({ state: 'waiting_human', failureReason: NO_CHANGE_REASON });
  } else {
    await deps.releaseIssue?.();
    // The step stays recorded: the run's step chain shows how far it went.
    await deps.record({
      state: scope.issueNumber === null ? 'done' : 'no_change',
      failureReason: null,
    });
  }
  await ctx.count(state.metrics, { event: 'no_change' });
  return {
    ok: false,
    error: `No change: the agent made no commit on ${scope.branch} and opened no pull request.`,
    metadata: { outcome: 'no_change' },
  };
}

/** `create_pr`: the pull request the agent opened from the run's branch, or the run's "no change" end. */
export async function createPrStep(ctx: ProviderContext): Promise<ActionResult> {
  const { deps, scope, state } = ctx;
  const reader = readerOf(ctx);
  const found = await deps.github.findPullRequest(reader, scope.branch);
  if (found.isErr()) return { ok: false, error: found.error.message };
  if (!found.value) {
    const ahead = await deps.github.branchAhead(reader, scope.branch);
    if (ahead.isOk() && !ahead.value) return noChange(ctx);
    return {
      ok: false,
      error: `No open pull request from the branch ${scope.branch}: the agent did not open one.`,
    };
  }
  const prUrl = found.value.url;
  state.prUrl = prUrl;
  await deps.record({ state: 'pr_open', prUrl });
  return { ok: true, output: prUrl, metadata: { number: found.value.number } };
}

/**
 * A flow's `run_command`, run by the runner in the run's own checkout (the
 * implementing thread's), never on the server. The exit code decides: a
 * non-zero exit, a timeout or a stop fails the step with the end of its output.
 */
export async function runCommandStep(
  ctx: ProviderContext,
  opts: RunCommandOpts,
): Promise<ActionResult> {
  const { deps } = ctx;
  if (!deps.steps) {
    return refused('run_command', 'this server cannot run factory steps on a runner.');
  }
  const threadId = ctx.state.threadIds[0];
  if (!threadId) {
    return {
      ok: false,
      error: 'run_command needs the run checkout: an agent step has to start it first.',
    };
  }
  const timeoutMs = opts.timeout ?? DEFAULT_STEP_TIMEOUT_MS;
  const run = await runStepOnRunner(
    deps.steps,
    threadId,
    { kind: 'command', command: opts.command, timeoutMs },
    deps.signal,
  );
  if (run.kind === 'unavailable') {
    return { ok: false, error: `run_command could not run: ${run.why}` };
  }
  if (run.result.kind !== 'command') return { ok: false, error: 'run_command: unexpected result.' };
  const { outcome, exitCode, stdout, stderr, durationMs } = run.result;
  const metadata = { outcome, exitCode, stdout, stderr, durationMs };
  if (outcome === 'passed') return { ok: true, output: stdout, metadata };
  const tail = (stderr.trim() || stdout.trim()).slice(-4000);
  const how = outcome === 'failed' ? `exited ${exitCode}` : outcome;
  return { ok: false, error: `The command ${how}:\n${tail}`, metadata };
}
