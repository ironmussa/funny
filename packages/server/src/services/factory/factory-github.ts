/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * The factory's GitHub side (change issue-factory, phase 2): resolve a project's
 * repository and list the open, labelled issues the watcher admits. The repo URL
 * is read from the project's own runner (its checkout's `origin`, the same call
 * sandbox launch uses); issues are read with a repository-scoped GitHub App
 * installation token capped by the enabler's own access — the identical token
 * path sandbox threads use. Neither the enabler's PAT nor the App key is ever
 * part of a result.
 */

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { accessCapToken } from '../github-app/access-cap-token.js';
import { loadGithubAppConfig, sqlSettingsStore } from '../github-app/app-config.js';
import { githubRepoOf } from '../github-app/sandbox-tokens.js';
import {
  createGithubAppTokenIssuer,
  type IssueError,
  type RepoToken,
} from '../github-app/token-issuer.js';
import type { RunnerPorts } from '../runner-thread-launcher.js';
import { createSandboxRunnerCalls } from '../thread-sandboxes/sandbox-runner-calls.js';

/** One open issue the factory may admit. */
export interface FactoryIssue {
  number: number;
  title: string;
  url: string;
}

export type FactoryGithubError = { kind: IssueError['kind']; message: string };

export interface FactoryGithubPort {
  /** `owner/name` (lowercase) for the project's repo, or null when it can't be resolved now. */
  resolveRepo(userId: string, projectId: string): Promise<string | null>;
  /** Open issues carrying `label`, oldest first, pull requests excluded. */
  listReadyIssues(input: {
    repo: string;
    ownerId: string;
    projectId: string | null;
    label: string;
  }): ResultAsync<FactoryIssue[], FactoryGithubError>;
}

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'funny-issue-factory';

interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  pull_request?: unknown;
}

/** Open, labelled issues from GitHub, oldest first, with PRs filtered out. */
function fetchIssues(
  fetchImpl: typeof fetch,
  repoToken: RepoToken,
  repo: string,
  label: string,
): ResultAsync<FactoryIssue[], FactoryGithubError> {
  const query = new URLSearchParams({
    state: 'open',
    labels: label,
    sort: 'created',
    direction: 'asc',
    per_page: '100',
  });
  const githubError = (message: string): FactoryGithubError => ({ kind: 'github-error', message });
  return ResultAsync.fromPromise(
    fetchImpl(`${GITHUB_API}/repos/${repo}/issues?${query.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${repoToken.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
      },
    }),
    (e) => githubError(e instanceof Error ? e.message : String(e)),
  ).andThen((res) => {
    if (!res.ok) {
      return errAsync<FactoryIssue[], FactoryGithubError>(
        githubError(`GitHub answered ${res.status} for ${repo}`),
      );
    }
    return ResultAsync.fromPromise(res.json() as Promise<RawIssue[]>, () =>
      githubError('unreadable issues response'),
    ).map((raw) =>
      // GitHub's issues endpoint also returns PRs; they carry `pull_request`.
      raw
        .filter((i) => !i.pull_request)
        .map((i) => ({ number: i.number, title: i.title, url: i.html_url })),
    );
  });
}

/** The production GitHub side: the project's runner for the repo, the deployment's App for tokens. */
export function createFactoryGithub(
  ports: RunnerPorts,
  fetchImpl: typeof fetch = fetch,
): FactoryGithubPort {
  const runnerCalls = createSandboxRunnerCalls({
    requests: ports.requests,
    presence: ports.presence,
  });
  const tokenIssuer = createGithubAppTokenIssuer({
    app: () => loadGithubAppConfig(process.env, sqlSettingsStore),
    fetch: fetchImpl,
  });

  // The factory's enabler may be a member, not the project owner: cap by their
  // own access (access-cap-token), never by the owner's project token.
  const ownerToken = accessCapToken;

  return {
    async resolveRepo(userId, projectId) {
      const remote = await runnerCalls.projectRemoteUrl({ userId, projectId });
      return remote.isOk() ? githubRepoOf(remote.value) : null;
    },

    listReadyIssues({ repo, ownerId, projectId, label }) {
      return ResultAsync.fromSafePromise(ownerToken(ownerId, projectId))
        .andThen((token) =>
          tokenIssuer
            .issue(repo, token)
            .mapErr((e): FactoryGithubError => ({ kind: e.kind, message: e.message })),
        )
        .andThen((repoToken) => fetchIssues(fetchImpl, repoToken, repo, label));
    },
  };
}
