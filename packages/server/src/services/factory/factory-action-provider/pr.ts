/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * `create_pr` of the factory's `ActionProvider`: the pull request the agent
 * opened from the run's branch, or the run's "no change" outcome.
 */

import type { ActionResult } from '@funny/workflows/compiler';

import { log } from '../../../lib/logger.js';
import type { ActionCore } from './core.js';
import { keptWorktreeLine, NO_CHANGE_LINE, NO_CHANGE_REASON } from './shared.js';

/** `create_pr`: find the agent's pull request, or end the run with no change. */
export function createPullRequestStep(core: ActionCore) {
  const { deps, scope, threadIds, state, count, reader } = core;
  /** Say the no-change outcome on the issue; a comment that fails is logged, not fatal. */
  async function commentNoChange(issueNumber: number, body: string): Promise<void> {
    const commented = await deps.github.commentOnIssue(reader, issueNumber, body);
    if (commented.isOk()) return;
    log.warn('Issue factory could not comment a no-change outcome on the issue', {
      namespace: 'factory',
      runId: scope.runId,
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
  async function noChange(): Promise<ActionResult> {
    const threadId = threadIds[0];
    const explanation = threadId ? await deps.lastThreadMessage?.(threadId) : null;
    const kept = (await deps.removeUnchangedWorktrees?.()) ?? [];
    const body = [NO_CHANGE_LINE, explanation, ...kept.map(keptWorktreeLine)]
      .filter(Boolean)
      .join('\n\n');
    // A run without an issue has none to comment on or hand back: with nothing kept, it is done.
    if (scope.issueNumber !== null) await commentNoChange(scope.issueNumber, body);
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
    await count(state.metrics, { event: 'no_change' });
    return {
      ok: false,
      error: `No change: the agent made no commit on ${scope.branch} and opened no pull request.`,
      metadata: { outcome: 'no_change' },
    };
  }

  async function createPr(): Promise<ActionResult> {
    const found = await deps.github.findPullRequest(reader, scope.branch);
    if (found.isErr()) return { ok: false, error: found.error.message };
    if (!found.value) {
      const ahead = await deps.github.branchAhead(reader, scope.branch);
      if (ahead.isOk() && !ahead.value) return noChange();
      return {
        ok: false,
        error: `No open pull request from the branch ${scope.branch}: the agent did not open one.`,
      };
    }
    state.prUrl = found.value.url;
    await deps.record({ state: 'pr_open', prUrl: state.prUrl });
    return { ok: true, output: state.prUrl, metadata: { number: found.value.number } };
  }

  return { createPr };
}
