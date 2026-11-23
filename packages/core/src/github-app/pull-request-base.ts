/**
 * Keeping a pull request up to date with its base branch (change
 * factory-agent-roles, D8): how far behind it is, GitHub's update-branch (a
 * merge commit made by GitHub, no checkout), a commit's parents, and what the
 * base gained in between. Called with a repository-scoped token through
 * `RepoGithub`.
 */

import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

import type { GithubCallError, RepoGithub } from './repo-github.js';

/** A ref or commit as a path segment sequence: `release/1.x` keeps its slashes. */
const refPath = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

export interface BaseDistance {
  /** Commits of the base that `head` does not have. */
  behindBy: number;
  /** Commits of `head` that the base does not have. */
  aheadBy: number;
}

interface RestCompare {
  ahead_by: number;
  behind_by: number;
  commits?: Array<{ sha: string; commit?: { message?: string } }>;
  files?: Array<{ filename: string }>;
}

/** How far `head` is from `base` (`GET /compare/{base}...{head}`). */
export function baseDistance(
  github: RepoGithub,
  repo: string,
  base: string,
  head: string,
): ResultAsync<BaseDistance, GithubCallError> {
  return github
    .json<RestCompare>(repo, 'GET', `/repos/${repo}/compare/${refPath(base)}...${refPath(head)}`)
    .map((compare) => ({ behindBy: compare.behind_by, aheadBy: compare.ahead_by }));
}

export type UpdateBranchResult =
  /** GitHub accepted it: a merge commit of the base lands on the branch shortly. */
  | { kind: 'updating' }
  /** The base does not merge into the branch cleanly. */
  | { kind: 'conflict'; reason: string }
  /** The branch head is no longer `expectedHeadSha`. */
  | { kind: 'head-moved' }
  /** GitHub refused for another reason (a rule, a permission). */
  | { kind: 'refused'; reason: string };

/**
 * Ask GitHub to merge the base branch into the pull request's branch
 * (`PUT /pulls/{n}/update-branch`), only while its head is `expectedHeadSha`.
 * Never a rebase: the branch's commits stay as they are.
 */
export function updateBranch(
  github: RepoGithub,
  repo: string,
  number: number,
  expectedHeadSha: string,
): ResultAsync<UpdateBranchResult, GithubCallError> {
  return github
    .json(repo, 'PUT', `/repos/${repo}/pulls/${number}/update-branch`, {
      expected_head_sha: expectedHeadSha,
    })
    .map((): UpdateBranchResult => ({ kind: 'updating' }))
    .orElse((e): ResultAsync<UpdateBranchResult, GithubCallError> => {
      if (e.status !== 422 && e.status !== 409) return errAsync(e);
      const reason = e.detail ?? e.message;
      if (/conflict/i.test(reason)) return okAsync({ kind: 'conflict', reason });
      if (/expected.head|head (sha|ref)/i.test(reason)) return okAsync({ kind: 'head-moved' });
      return okAsync({ kind: 'refused', reason });
    });
}

/** The parents of a commit, first parent first. */
export function commitParents(
  github: RepoGithub,
  repo: string,
  sha: string,
): ResultAsync<string[], GithubCallError> {
  return github
    .json<{ parents?: Array<{ sha: string }> }>(repo, 'GET', `/repos/${repo}/commits/${sha}`)
    .map((commit) => (commit.parents ?? []).map((parent) => parent.sha));
}

export interface BaseChanges {
  /** The commits the base has that `head` does not, oldest first: their first line. */
  commits: Array<{ sha: string; title: string }>;
  /** The files those commits changed (GitHub lists at most 300). */
  files: string[];
}

/** What `base` gained that `head` does not have (`GET /compare/{head}...{base}`). */
export function baseChangesSince(
  github: RepoGithub,
  repo: string,
  head: string,
  base: string,
): ResultAsync<BaseChanges, GithubCallError> {
  return github
    .json<RestCompare>(repo, 'GET', `/repos/${repo}/compare/${refPath(head)}...${refPath(base)}`)
    .map((compare) => ({
      commits: (compare.commits ?? []).map((commit) => ({
        sha: commit.sha,
        title: (commit.commit?.message ?? '').split('\n')[0] ?? '',
      })),
      files: (compare.files ?? []).map((file) => file.filename),
    }));
}
