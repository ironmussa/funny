/**
 * An issue's blockers: GitHub's native "blocked by" relation
 * (`GET /repos/{repo}/issues/{n}/dependencies/blocked_by`), read with the
 * caller's repository client and therefore its token.
 */

import { okAsync, type ResultAsync } from 'neverthrow';

import type { GithubCallError, RepoGithub } from './repo-github.js';

/** One issue that blocks another. */
export interface IssueBlocker {
  number: number;
  /** `owner/name` (lowercase) of the blocker's repository; it may differ from the blocked issue's. */
  repo: string;
  /** A blocker of unknown state counts as open: in doubt, the issue waits. */
  open: boolean;
}

interface RestBlocker {
  number: number;
  state?: string;
  /** `https://api.github.com/repos/{owner}/{name}`. */
  repository_url?: string;
}

const PAGE_SIZE = 100;
/** Longer lists are cut (10 000 blockers). */
const MAX_PAGES = 100;

const repoOf = (blocker: RestBlocker, fallback: string): string => {
  const match = blocker.repository_url?.match(/\/repos\/([^/]+\/[^/]+)$/);
  return (match?.[1] ?? fallback).toLowerCase();
};

/** Every blocker of issue `number` in `repo`, open or closed. */
export function issueBlockers(
  github: RepoGithub,
  repo: string,
  number: number,
): ResultAsync<IssueBlocker[], GithubCallError> {
  const path = `/repos/${repo}/issues/${number}/dependencies/blocked_by`;
  const page = (n: number, acc: RestBlocker[]): ResultAsync<RestBlocker[], GithubCallError> =>
    github
      .json<RestBlocker[]>(repo, 'GET', `${path}?per_page=${PAGE_SIZE}&page=${n}`)
      .andThen((items) =>
        items.length < PAGE_SIZE || n >= MAX_PAGES
          ? okAsync([...acc, ...items])
          : page(n + 1, [...acc, ...items]),
      );
  return page(1, []).map((blockers) =>
    blockers.map((b) => ({
      number: b.number,
      repo: repoOf(b, repo),
      open: b.state !== 'closed',
    })),
  );
}
