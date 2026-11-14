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

/** How the pull request stands for merging. */
export interface MergeState {
  state: 'open' | 'merged' | 'closed';
  /** Whether GitHub's auto-merge is enabled on it (a push or a person may turn it off). */
  autoMerge: boolean;
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';

export type AutoMergeResult =
  /** GitHub merges it once its requirements are met (reviews, checks). */
  | { kind: 'enabled'; method: MergeMethod }
  /** Its requirements were already met: merged at once, the same way. */
  | { kind: 'merged'; method: MergeMethod }
  /** The repository does not allow auto-merge (or no merge method). */
  | { kind: 'unavailable'; reason: string }
  /** It met its requirements, then no longer did (a push, a new review rule): look again later. */
  | { kind: 'not-mergeable'; reason: string };

export interface PullRequestCi {
  ciState(repo: string, number: number): ResultAsync<CiState, IssueSourceError>;
  /** Take the pull request out of draft. */
  markReady(repo: string, number: number): ResultAsync<void, IssueSourceError>;
  /**
   * Enable GitHub's auto-merge, with squash when the repository allows it,
   * else another allowed method. Never bypasses branch protections.
   */
  enableAutoMerge(repo: string, number: number): ResultAsync<AutoMergeResult, IssueSourceError>;
  mergeState(repo: string, number: number): ResultAsync<MergeState, IssueSourceError>;
  /** The URL of the open pull request from `branch`, or null when there is none. */
  findOpen(repo: string, branch: string): ResultAsync<string | null, IssueSourceError>;
  /** Delete a branch on GitHub; a branch already gone is not an error. */
  deleteBranch(repo: string, branch: string): ResultAsync<void, IssueSourceError>;
}
