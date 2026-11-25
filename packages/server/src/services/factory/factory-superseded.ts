/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * Closing the pull requests a merged run superseded (openspec
 * factory-close-superseded-prs). When a run of an issue merges, the earlier
 * runs of the same issue that ended without merging (stopped, failed) may
 * still have their pull requests open, with nobody working on them. The
 * factory closes each one whose head is still a commit it recorded for that
 * run, through the same `closeReplaced` a member uses from the board: a
 * comment naming the merged pull request, the close, the branch deletion and
 * a `factory.close-pr` activity (origin `system`).
 *
 * The candidates come from the factory's own rows, never from a GitHub branch
 * search: a pull request no run of the factory opened is not the factory's to
 * close. A run taken over or retried is back in flight, so it is never one.
 */

import { prNumberOf, type FactoryPullRequests } from './factory-pull-requests.js';
import { factoryRunBranch, type FactoryRunView } from './factory-runs-model.js';

/** End states whose open pull request a later merge of the issue supersedes. */
const SUPERSEDED_STATES: ReadonlySet<FactoryRunView['state']> = new Set(['stopped', 'failed']);

type SupersedableRun = Pick<
  FactoryRunView,
  | 'id'
  | 'issueNumber'
  | 'state'
  | 'prUrl'
  | 'reviews'
  | 'risk'
  | 'mergeApproval'
  | 'regressionProof'
>;

/** A run whose pull request `merged` superseded, with that pull request's number. */
export interface SupersededPullRequest<R extends SupersedableRun = SupersedableRun> {
  run: R;
  number: number;
}

/**
 * The runs of `runs` whose pull request the merged run `merged` superseded:
 * the same issue, ended without merging, with a pull request of their own.
 */
export function supersededPullRequests<R extends SupersedableRun>(
  merged: SupersedableRun,
  runs: readonly R[],
): SupersededPullRequest<R>[] {
  if (merged.state !== 'merged' || merged.issueNumber === null) return [];
  const mergedPr = prNumberOf(merged.prUrl);
  const found: SupersededPullRequest<R>[] = [];
  for (const run of runs) {
    if (run.id === merged.id || run.issueNumber !== merged.issueNumber) continue;
    if (!SUPERSEDED_STATES.has(run.state)) continue;
    const number = prNumberOf(run.prUrl);
    if (number === null || number === mergedPr) continue;
    found.push({ run, number });
  }
  return found;
}

/**
 * The commits the factory recorded for a run's pull request: those it
 * reviewed, classified, proved, or a member approved. A head outside them was
 * pushed by somebody else, and that pull request is left open.
 */
export function recordedHeads(run: SupersedableRun): Set<string> {
  const heads = new Set<string>();
  for (const review of run.reviews) heads.add(review.sha);
  if (run.risk) heads.add(run.risk.headSha);
  if (run.regressionProof) heads.add(run.regressionProof.headSha);
  if (run.mergeApproval) heads.add(run.mergeApproval.sha);
  return heads;
}

/** Why a superseded pull request was left open, or `closed`. */
export type SupersededOutcome =
  | { number: number; kind: 'closed' }
  | { number: number; kind: 'not-open' }
  | { number: number; kind: 'head-moved'; head: string }
  | { number: number; kind: 'failed'; error: string };

export interface CloseSupersededDeps {
  /** The merged run's factory: its enabler acts, on its repository. */
  owner: { userId: string; projectId: string; repo: string };
  /** The runs of the merged run's factory. */
  runs: readonly FactoryRunView[];
  pullRequests: Pick<FactoryPullRequests, 'prState' | 'pullHead' | 'closeReplaced'>;
}

/**
 * Close the pull requests `merged` superseded, one after the other. A pull
 * request that is not open, or whose head the factory did not record, stays as
 * it is. One that GitHub refuses does not stop the next. Never throws.
 */
export async function closeSupersededPullRequests(
  deps: CloseSupersededDeps,
  merged: FactoryRunView,
): Promise<SupersededOutcome[]> {
  const close = deps.pullRequests.closeReplaced;
  if (!close) return [];
  const by = { issueNumber: merged.issueNumber, prNumber: prNumberOf(merged.prUrl) };
  const outcomes: SupersededOutcome[] = [];
  for (const { run, number } of supersededPullRequests(merged, deps.runs)) {
    const ref = {
      repo: deps.owner.repo,
      number,
      branch: factoryRunBranch(run),
      userId: deps.owner.userId,
      projectId: deps.owner.projectId,
    };
    const state = await deps.pullRequests.prState(ref);
    if (state.isErr()) {
      outcomes.push({ number, kind: 'failed', error: state.error.message });
      continue;
    }
    if (state.value !== 'open') {
      outcomes.push({ number, kind: 'not-open' });
      continue;
    }
    const head = await deps.pullRequests.pullHead(ref);
    if (head.isErr()) {
      outcomes.push({ number, kind: 'failed', error: head.error.message });
      continue;
    }
    if (!recordedHeads(run).has(head.value.sha)) {
      outcomes.push({ number, kind: 'head-moved', head: head.value.sha });
      continue;
    }
    const closed = await close(ref, by, 'system');
    outcomes.push(
      closed.isOk()
        ? { number, kind: 'closed' }
        : { number, kind: 'failed', error: closed.error.message },
    );
  }
  return outcomes;
}
