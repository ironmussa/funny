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
} from '@funny/core/github-app';
import { errAsync, okAsync, type ResultAsync } from 'neverthrow';

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
}

/** Label names from GitHub's issue payload, which lists labels as objects or strings. */
export function labelNames(labels: Array<string | { name?: string }> | undefined): string[] {
  return (labels ?? [])
    .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
    .filter((name) => name.length > 0);
}

export function createFactoryRepoReads(repo: string, github: RepoGithub) {
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

    /**
     * Whether `branch` has commits that the repository's DEFAULT branch does
     * not; a branch that does not exist on GitHub has none.
     */
    branchAhead(branch: string): ResultAsync<boolean, GithubCallError> {
      return github
        .json<{ default_branch: string }>(repo, 'GET', `/repos/${repo}`)
        .andThen((meta) =>
          createRepoCheckOps(github).isBranchAhead(repo, meta.default_branch, branch),
        )
        .map((compare) => compare.ahead);
    },

    /** The name of the repository's DEFAULT branch. */
    defaultBranch(): ResultAsync<string, GithubCallError> {
      return github
        .json<{ default_branch: string }>(repo, 'GET', `/repos/${repo}`)
        .map((meta) => meta.default_branch);
    },

    /** Comment on the issue, as the App. */
    commentOnIssue(issueNumber: number, body: string): ResultAsync<void, GithubCallError> {
      return github
        .json(repo, 'POST', `/repos/${repo}/issues/${issueNumber}/comments`, { body })
        .map(() => undefined);
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
     * `path` as of the default branch, or null when absent there. The ref is
     * always the default branch's, never the run's or a pull request's.
     */
    readDefaultBranchFile(path: string): ResultAsync<string | null, GithubCallError> {
      return github
        .json<{ default_branch: string }>(repo, 'GET', `/repos/${repo}`)
        .andThen((meta) =>
          github
            .json<{ content?: string; encoding?: string }>(
              repo,
              'GET',
              `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(meta.default_branch)}`,
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
            ),
        );
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
        .json<Array<{ number: number; html_url: string }>>(
          repo,
          'GET',
          `/repos/${repo}/pulls?${query.toString()}`,
        )
        .map((pulls) => (pulls[0] ? { number: pulls[0].number, url: pulls[0].html_url } : null));
    },
  };
}
