/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * Which pull request a member may close because its run was replaced. An issue
 * sent again gets a new run on a new branch, so the earlier run's pull request
 * stays open with nobody working on it. The rule is the board's (`supersededRuns`
 * in the client's `board-columns.ts`): a later-started run of the same issue,
 * in the same factory, replaces an earlier one. The server decides it again
 * from its own rows: the browser's word is not what closes a pull request.
 */

import { err, ok, type Result } from 'neverthrow';

import { prNumberOf, type FactoryReplacedBy } from './factory-pull-requests.js';
import { factoryRunBranch, type FactoryRunView } from './factory-runs-model.js';

type ReplaceableRun = Pick<FactoryRunView, 'id' | 'issueNumber' | 'state' | 'prUrl' | 'startedAt'>;

/** The pull request to close, the branch to delete with it, and what replaced its run. */
export interface ReplacedPullRequest {
  number: number;
  branch: string;
  by: FactoryReplacedBy;
}

/** The newest run of the same issue started after `run`, or null. */
export function replacementOf<R extends ReplaceableRun>(run: R, runs: readonly R[]): R | null {
  if (run.issueNumber === null) return null;
  const started = Date.parse(run.startedAt);
  let newest: R | null = null;
  for (const other of runs) {
    if (other.id === run.id || other.issueNumber !== run.issueNumber) continue;
    const at = Date.parse(other.startedAt);
    if (at > started && (newest === null || at > Date.parse(newest.startedAt))) newest = other;
  }
  return newest;
}

/**
 * The pull request of `run` a member may close, or why not. `runs` are the
 * runs of its factory. Only a run that ended without merging qualifies: a run
 * still in flight, or waiting for a person, may yet merge its pull request.
 */
export function replacedPullRequest(
  run: ReplaceableRun,
  runs: readonly ReplaceableRun[],
): Result<ReplacedPullRequest, string> {
  const replacement = replacementOf(run, runs);
  if (!replacement) return err('No newer run of the issue replaced this run.');
  if (run.state !== 'failed' && run.state !== 'stopped') {
    return err('The run has not ended: stop it before closing its pull request.');
  }
  const number = prNumberOf(run.prUrl);
  if (number === null) return err('The run has no pull request.');
  const replacedBy = prNumberOf(replacement.prUrl);
  if (replacedBy === number) return err('The newer run works on the same pull request.');
  return ok({
    number,
    branch: factoryRunBranch(run),
    by: { issueNumber: run.issueNumber, prNumber: replacedBy },
  });
}
