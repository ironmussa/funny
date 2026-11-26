/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * What a factory run reads from its repository on GitHub (change
 * factory-flow-execution): an issue, a flow file on the DEFAULT branch, and the
 * pull request the agent opened from the run's branch. The caller supplies the
 * REST client and therefore the token (`factory-github.ts`: the App token
 * capped by the enabler).
 */

import {
  createRepoCheckOps,
  issueBlockers,
  type GithubCallError,
  type IssueBlocker,
  type RepoGithub,
  createPullRequestCi,
  revertPullRequest,
  type CiState,
  type RevertPullRequest,
} from '@funny/core/github-app';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { isString } from '../../lib/value-guards.js';
import type { FactoryIssueText } from './factory-issue-text.js';

/** An issue as the factory admits it (`FactoryIssue`), with what a send checks. */
export interface RepoIssue {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  /** GitHub's issues endpoint also answers for pull requests. */
  pullRequest: boolean;
  createdAt: string;
  /** When the issue last changed (an edit, a comment, a label): GitHub's `updated_at`. */
  updatedAt?: string;
  /** The issue's label names. */
  labels?: string[];
}

/** An open pull request found by its head branch. */
/** Which pull requests of a branch to look at: the open one, or any (newest first). */
export type PullRequestLookup = 'open' | 'all';

export interface FactoryPullRequestFound {
  number: number;
  url: string;
  /** The branch it merges into, when GitHub said. */
  baseRef?: string;
}

/** Label names from GitHub's issue payload, which lists labels as objects or strings. */
export function labelNames(labels: Array<string | { name?: string }> | undefined): string[] {
  return (labels ?? [])
    .map((l) => (isString(l) ? l : (l.name ?? '')))
    .filter((name) => name.length > 0);
}

/**
 * `targetBranch`: the branch the factory merges into when its enabler chose
 * one (null: the repository's default branch). It moves where runs start, what
 * "ahead" is measured against and where pull requests merge; flows and their
 * prompts are still read from the default branch.
 */
export function createFactoryRepoReads(
  repo: string,
  github: RepoGithub,
  targetBranch: () => Promise<string | null> = async () => null,
) {
  const repoDefaultBranch = (): ResultAsync<string, GithubCallError> =>
    github
      .json<{ default_branch: string }>(repo, 'GET', `/repos/${repo}`)
      .map((meta) => meta.default_branch);

  /** The branch the factory merges into: the configured one, else the repository's default. */
  const mergeTarget = (): ResultAsync<string, GithubCallError> =>
    ResultAsync.fromSafePromise(targetBranch().catch(() => null)).andThen((configured) =>
      configured ? okAsync<string, GithubCallError>(configured) : repoDefaultBranch(),
    );

  /** `path` as of `ref` (a commit of the default branch), or null when absent there. */
  const readFileAt = (path: string, ref: string): ResultAsync<string | null, GithubCallError> =>
    github
      .json<{ content?: string; encoding?: string }>(
        repo,
        'GET',
        `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      )
      .map((file) =>
        file.encoding === 'base64' && file.content
          ? Buffer.from(file.content, 'base64').toString('utf8')
          : null,
      )
      .orElse((error) =>
        error.status === 404
          ? okAsync<string | null, GithubCallError>(null)
          : errAsync<string | null, GithubCallError>(error),
      );

  return {
    getIssue(issueNumber: number): ResultAsync<RepoIssue, GithubCallError> {
      return github
        .json<{
          number: number;
          title: string;
          html_url: string;
          state?: string;
          pull_request?: unknown;
          created_at?: string;
          updated_at?: string;
          labels?: Array<string | { name?: string }>;
        }>(repo, 'GET', `/repos/${repo}/issues/${issueNumber}`)
        .map((raw) => ({
          number: raw.number,
          title: raw.title,
          url: raw.html_url,
          state: raw.state === 'closed' ? 'closed' : 'open',
          pullRequest: Boolean(raw.pull_request),
          createdAt: raw.created_at ?? '',
          updatedAt: raw.updated_at,
          labels: labelNames(raw.labels),
        }));
    },

    /** An issue's title, body and comments (the newest 100), for a role with no network. */
    issueText(issueNumber: number): ResultAsync<FactoryIssueText, GithubCallError> {
      const base = `/repos/${repo}/issues/${issueNumber}`;
      return github
        .json<{ title: string; body?: string | null }>(repo, 'GET', base)
        .andThen((issue) =>
          github
            .json<Array<{ body?: string | null; user?: { login?: string } | null }>>(
              repo,
              'GET',
              `${base}/comments?per_page=100`,
            )
            .map((comments) => ({
              title: issue.title,
              body: issue.body ?? '',
              comments: comments.map((comment) => ({
                author: comment.user?.login ?? 'unknown',
                body: comment.body ?? '',
              })),
            })),
        );
    },

    /**
     * Whether `branch` has commits that the branch the factory merges into
     * does not; a branch that does not exist on GitHub has none.
     */
    branchAhead(branch: string): ResultAsync<boolean, GithubCallError> {
      return mergeTarget()
        .andThen((base) => createRepoCheckOps(github).isBranchAhead(repo, base, branch))
        .map((compare) => compare.ahead);
    },

    /**
     * The branch the factory merges into (and starts runs from): the one its
     * enabler configured, else the repository's DEFAULT branch.
     */
    defaultBranch(): ResultAsync<string, GithubCallError> {
      return mergeTarget();
    },

    /**
     * Make `branch` from the head of the branch the factory merges into, when
     * GitHub has no such branch (change factory-lanes, D1): `created`, or
     * `exists` when it was there already (also when another admission made it
     * a moment ago).
     */
    ensureBranch(branch: string): ResultAsync<'created' | 'exists', GithubCallError> {
      const ref = (name: string) =>
        `/repos/${repo}/git/ref/heads/${name.split('/').map(encodeURIComponent).join('/')}`;
      const made = (): ResultAsync<'created' | 'exists', GithubCallError> =>
        mergeTarget()
          .andThen((base) => github.json<{ object: { sha: string } }>(repo, 'GET', ref(base)))
          .andThen((head) =>
            github
              .json(repo, 'POST', `/repos/${repo}/git/refs`, {
                ref: `refs/heads/${branch}`,
                sha: head.object.sha,
              })
              .map(() => 'created' as const)
              // 422: the reference exists already.
              .orElse((error) =>
                error.status === 422
                  ? okAsync<'created' | 'exists', GithubCallError>('exists')
                  : errAsync<'created' | 'exists', GithubCallError>(error),
              ),
          );
      return github
        .json(repo, 'GET', ref(branch))
        .map(() => 'exists' as const)
        .orElse((error) =>
          error.status === 404 ? made() : errAsync<'created' | 'exists', GithubCallError>(error),
        );
    },

    /** The commit a branch is at, and the verdict of its checks. */
    branchState(branch: string): ResultAsync<{ sha: string; ci: CiState }, GithubCallError> {
      return createPullRequestCi(github).refState(repo, branch);
    },

    /** The commit merged pull request `number` made, and its checks; null when not merged. */
    mergeCommitState(
      number: number,
    ): ResultAsync<{ sha: string; ci: CiState } | null, GithubCallError> {
      return github
        .json<{ merged?: boolean; merge_commit_sha?: string | null }>(
          repo,
          'GET',
          `/repos/${repo}/pulls/${number}`,
        )
        .andThen((pull) =>
          pull.merged && pull.merge_commit_sha
            ? createPullRequestCi(github).refState(repo, pull.merge_commit_sha)
            : okAsync(null),
        );
    },

    /** Open a pull request that reverts merged pull request `number` (it is not merged here). */
    revertPullRequest(
      number: number,
      text: { title?: string; body?: string },
    ): ResultAsync<RevertPullRequest, GithubCallError> {
      return revertPullRequest(github, repo, number, text);
    },

    /**
     * Take `remove` off the issue (when given; an issue that does not carry it
     * is fine) and put `add` on it (when given), as the App. GitHub creates
     * `add` when the repository has no such label.
     */
    relabelIssue(
      issueNumber: number,
      labels: { remove?: string; add?: string },
    ): ResultAsync<void, GithubCallError> {
      const issuePath = `/repos/${repo}/issues/${issueNumber}/labels`;
      const removed: ResultAsync<void, GithubCallError> = labels.remove
        ? github
            .json(repo, 'DELETE', `${issuePath}/${encodeURIComponent(labels.remove)}`)
            .map(() => undefined)
            .orElse((error) => (error.status === 404 ? okAsync(undefined) : errAsync(error)))
        : okAsync(undefined);
      const add = labels.add;
      return removed.andThen(() =>
        add
          ? github.json(repo, 'POST', issuePath, { labels: [add] }).map(() => undefined)
          : okAsync(undefined),
      );
    },

    /** Comment on the issue, as the App. */
    commentOnIssue(issueNumber: number, body: string): ResultAsync<void, GithubCallError> {
      return github
        .json(repo, 'POST', `/repos/${repo}/issues/${issueNumber}/comments`, { body })
        .map(() => undefined);
    },

    /** Close an issue as completed, as the App. */
    closeIssue(issueNumber: number): ResultAsync<void, GithubCallError> {
      return github
        .json(repo, 'PATCH', `/repos/${repo}/issues/${issueNumber}`, {
          state: 'closed',
          state_reason: 'completed',
        })
        .map(() => undefined);
    },

    /** Open an issue, as the App. */
    createIssue(issue: {
      title: string;
      body: string;
    }): ResultAsync<{ number: number; url: string }, GithubCallError> {
      return github
        .json<{ number: number; html_url: string }>(repo, 'POST', `/repos/${repo}/issues`, issue)
        .map((created) => ({ number: created.number, url: created.html_url }));
    },

    /** The issue's blockers (GitHub's "blocked by" relation), open or closed. */
    blockers(issueNumber: number): ResultAsync<IssueBlocker[], GithubCallError> {
      return issueBlockers(github, repo, issueNumber);
    },

    /**
     * The names of the files in directory `path` of the default branch, or an
     * empty list when the directory is absent there.
     */
    listDefaultBranchDir(path: string): ResultAsync<string[], GithubCallError> {
      return github
        .json<{ default_branch: string }>(repo, 'GET', `/repos/${repo}`)
        .andThen((meta) =>
          github
            .json<Array<{ name: string; type: string }>>(
              repo,
              'GET',
              `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(meta.default_branch)}`,
            )
            .map((entries) =>
              Array.isArray(entries)
                ? entries.filter((e) => e.type === 'file').map((e) => e.name)
                : [],
            )
            .orElse((error) =>
              error.status === 404
                ? okAsync<string[], GithubCallError>([])
                : errAsync<string[], GithubCallError>(error),
            ),
        );
    },

    /**
     * The default branch and the commit it is at now. A flow and its prompt
     * files are read at that commit, so they come from one version of the
     * branch even while it moves.
     */
    defaultBranchHead(): ResultAsync<{ branch: string; sha: string }, GithubCallError> {
      return github
        .json<{ default_branch: string }>(repo, 'GET', `/repos/${repo}`)
        .andThen((meta) =>
          github
            .json<{ sha: string }>(
              repo,
              'GET',
              `/repos/${repo}/commits/${encodeURIComponent(meta.default_branch)}`,
            )
            .map((commit) => ({ branch: meta.default_branch, sha: commit.sha })),
        );
    },

    readFileAt,

    /**
     * `path` as of the default branch, or null when absent there. The ref is
     * always the default branch's, never the run's or a pull request's.
     */
    readDefaultBranchFile(path: string): ResultAsync<string | null, GithubCallError> {
      return github
        .json<{ default_branch: string }>(repo, 'GET', `/repos/${repo}`)
        .andThen((meta) => readFileAt(path, meta.default_branch));
    },

    /**
     * The pull request whose head is `branch` in the repository itself, or null:
     * the open one by default, or the newest in any state (`'all'`, which also
     * finds one already merged or closed).
     */
    findPullRequest(
      branch: string,
      state: PullRequestLookup = 'open',
    ): ResultAsync<FactoryPullRequestFound | null, GithubCallError> {
      const owner = repo.split('/')[0];
      const query = new URLSearchParams({ head: `${owner}:${branch}`, state });
      return github
        .json<Array<{ number: number; html_url: string; base?: { ref?: string } }>>(
          repo,
          'GET',
          `/repos/${repo}/pulls?${query.toString()}`,
        )
        .map((pulls) =>
          pulls[0]
            ? {
                number: pulls[0].number,
                url: pulls[0].html_url,
                ...(pulls[0].base?.ref && { baseRef: pulls[0].base.ref }),
              }
            : null,
        );
    },
  };
}
