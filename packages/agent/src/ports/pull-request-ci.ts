/**
 * A factory run's pull request as the orchestrator follows it after the step
 * runner opened it: its CI, its mergeability, and marking it ready.
 */

import type { ResultAsync } from 'neverthrow';

import type { FailingCheck } from '../steps/fix.js';
import type { IssueSourceError } from './issue-source.js';

export type CiState =
  /** Checks still running (or not reported yet). */
  | { kind: 'pending' }
  /** Every check passed. */
  | { kind: 'green' }
  /** No check or status reported on the head commit (yet, or the repository has no CI). */
  | { kind: 'none' }
  /** At least one check failed; none is still running. */
  | { kind: 'failing'; checks: FailingCheck[] }
  /** The pull request conflicts with its base. */
  | { kind: 'conflict' };

export interface PullRequestCi {
  ciState(repo: string, number: number): ResultAsync<CiState, IssueSourceError>;
  /** Take the pull request out of draft. */
  markReady(repo: string, number: number): ResultAsync<void, IssueSourceError>;
}
