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

import {
  createRepoGithub,
  type CiState,
  type GithubCallError,
  type IssueBlocker,
  type RevertPullRequest,
} from '@funny/core/github-app';
import { errAsync, ResultAsync } from 'neverthrow';

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
import type { FactoryIssueText } from './factory-issue-text.js';
import { createFactoryPullRequests, type FactoryPullRequests } from './factory-pull-requests.js';
import {
  createFactoryRepoReads,
  labelNames,
  type FactoryPullRequestFound,
  type PullRequestLookup,
  type RepoIssue,
} from './factory-repo-reads.js';
import { factoryBaseBranchOf } from './factory-settings.js';

/** One open issue the factory may admit. */
export interface FactoryIssue {
  number: number;
  title: string;
  url: string;
  /** The issue's label names, when known (a flow's `require_test: labels` reads them). */
  labels?: string[];
}

/** One issue as GitHub has it now: what a send and the queue check before admitting. */
export type FactoryIssueDetail = FactoryIssue & Partial<Omit<RepoIssue, keyof FactoryIssue>>;

export type FactoryGithubError = { kind: IssueError['kind']; message: string };

/** Who reads the repository: the factory's enabler, whose access caps the token. */
export interface FactoryRepoReader {
  repo: string;
  ownerId: string;
  projectId: string;
  /**
   * The base branch of the run this read is for (change factory-lanes, D3):
   * what `defaultBranch()` answers. Absent for a read with no run, which gets
   * the factory's "merge into" branch.
   */
  baseBranch?: string | null;
}

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
  /** One issue, for resuming a run whose issue may no longer carry the label. */
  getIssue(
    reader: FactoryRepoReader,
    issueNumber: number,
  ): ResultAsync<FactoryIssueDetail, GithubCallError>;
  /** The issue's blockers (GitHub's native "blocked by" relation), open or closed. */
  issueBlockers(
    reader: FactoryRepoReader,
    issueNumber: number,
  ): ResultAsync<IssueBlocker[], GithubCallError>;
  /** The file names in a directory of the DEFAULT branch; empty when it is absent. */
  listDefaultBranchDir(
    reader: FactoryRepoReader,
    path: string,
  ): ResultAsync<string[], GithubCallError>;
  /**
   * A file on the repository's DEFAULT branch (never another branch, so a pull
   * request cannot change the flow that reviews it), or null when it is absent.
   */
  readDefaultBranchFile(
    reader: FactoryRepoReader,
    path: string,
  ): ResultAsync<string | null, GithubCallError>;
  /** The default branch and the commit it is at now. */
  defaultBranchHead(
    reader: FactoryRepoReader,
  ): ResultAsync<{ branch: string; sha: string }, GithubCallError>;
  /** A file as of `ref` (a commit of the default branch), or null when absent there. */
  readFileAt(
    reader: FactoryRepoReader,
    path: string,
    ref: string,
  ): ResultAsync<string | null, GithubCallError>;
  /**
   * The pull request whose head is `branch` in the repository itself, or null:
   * the open one unless `state` is `'all'` (the newest, merged or closed too).
   */
  findPullRequest(
    reader: FactoryRepoReader,
    branch: string,
    state?: PullRequestLookup,
  ): ResultAsync<FactoryPullRequestFound | null, GithubCallError>;
  /** Whether `branch` has commits the DEFAULT branch does not (none when it is absent). */
  branchAhead(reader: FactoryRepoReader, branch: string): ResultAsync<boolean, GithubCallError>;
  /** Swap an issue's label (see `relabelIssue` in `factory-repo-reads.ts`). */
  relabelIssue(
    reader: FactoryRepoReader,
    issueNumber: number,
    labels: { remove?: string; add?: string },
  ): ResultAsync<void, GithubCallError>;
  /** The name of the repository's DEFAULT branch: what a run's worktree starts from. */
  defaultBranch(reader: FactoryRepoReader): ResultAsync<string, GithubCallError>;
  /** The commit `branch` is at and the verdict of its checks (the base branch after merges). */
  branchState(
    reader: FactoryRepoReader,
    branch: string,
  ): ResultAsync<{ sha: string; ci: CiState }, GithubCallError>;
  /** An issue's title, body and comments, for a read-only role (it has no network). */
  issueText(
    reader: FactoryRepoReader,
    issueNumber: number,
  ): ResultAsync<FactoryIssueText, GithubCallError>;
  /**
   * The commit merged pull request `number` made on its base branch and the
   * verdict of that commit's checks, or null when it is not merged.
   */
  mergeCommitState(
    reader: FactoryRepoReader,
    number: number,
  ): ResultAsync<{ sha: string; ci: CiState } | null, GithubCallError>;
  /** Open a pull request that reverts a merged one. Never merged by the factory. */
  revertPullRequest(
    reader: FactoryRepoReader,
    number: number,
    text: { title?: string; body?: string },
  ): ResultAsync<RevertPullRequest, GithubCallError>;
  /** Comment on an issue, as the App. */
  commentOnIssue(
    reader: FactoryRepoReader,
    issueNumber: number,
    body: string,
  ): ResultAsync<void, GithubCallError>;
  /**
   * Open an issue, as the App with the token capped by `reader.ownerId`'s own
   * access (the person who asked for it). Absent in fakes that never open one.
   */
  createIssue?(
    reader: FactoryRepoReader,
    issue: { title: string; body: string },
  ): ResultAsync<{ number: number; url: string }, GithubCallError>;
  /**
   * Close an issue as completed, as the App with the token capped by
   * `reader.ownerId`'s own access. Absent in fakes that never close one.
   */
  closeIssue?(reader: FactoryRepoReader, issueNumber: number): ResultAsync<void, GithubCallError>;
  /**
   * Make `branch` from the head of the branch the factory merges into when it
   * does not exist (a lane's branch, change factory-lanes). Absent: the
   * factory cannot make branches, and a lane whose branch is missing is refused.
   */
  ensureBranch?(
    reader: FactoryRepoReader,
    branch: string,
  ): ResultAsync<'created' | 'exists', GithubCallError>;
  /** Whether `branch` contains commit `sha`. Absent: unknown, read as "not yet". */
  branchContains?(
    reader: FactoryRepoReader,
    branch: string,
    sha: string,
  ): ResultAsync<boolean, GithubCallError>;
  /** The commit merged pull request `number` made, or null when it is not merged. */
  mergeCommit?(
    reader: FactoryRepoReader,
    number: number,
  ): ResultAsync<string | null, GithubCallError>;
  /** CI state and merge of a run's pull request (`wait_ci` / `merge`). */
  pullRequests: FactoryPullRequests;
}

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'funny-issue-factory';

interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  pull_request?: unknown;
  labels?: Array<string | { name?: string }>;
}

/** Open, labelled issues from GitHub, oldest first, with PRs filtered out. */
/**
 * The most labelled issues one listing returns (one page, oldest first). A
 * listing this long may leave issues out, so the watcher does not read an
 * issue's absence from it as its label having been taken off.
 */
export const READY_ISSUES_PAGE = 100;

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
    per_page: String(READY_ISSUES_PAGE),
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
    // SAFETY: res.ok held; GitHub's list-issues endpoint answers a JSON array of issue objects.
    return ResultAsync.fromPromise(res.json() as Promise<RawIssue[]>, () =>
      githubError('unreadable issues response'),
    ).map((raw) =>
      // GitHub's issues endpoint also returns PRs; they carry `pull_request`.
      raw
        .filter((i) => !i.pull_request)
        .map((i) => ({
          number: i.number,
          title: i.title,
          url: i.html_url,
          labels: labelNames(i.labels),
        })),
    );
  });
}

/**
 * The branch a reader's "base" is (change factory-lanes, D3): the one recorded
 * on the run it reads for, else the factory's "merge into" setting (null: the
 * repository's default branch). The setting is not read when the run has one.
 */
export async function readerBaseBranch(
  reader: FactoryRepoReader,
  settingOf: (ownerId: string, projectId: string) => Promise<string | null>,
): Promise<string | null> {
  return reader.baseBranch || settingOf(reader.ownerId, reader.projectId);
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
  const issue = (repo: string, token: string | null) => tokenIssuer.issue(repo, token);

  /** Reads on the enabler's behalf: the App token for the repo, capped by their access. */
  const reads = (reader: FactoryRepoReader) =>
    createFactoryRepoReads(
      reader.repo,
      createRepoGithub({
        tokenFor: (repo) =>
          ResultAsync.fromSafePromise(ownerToken(reader.ownerId, reader.projectId))
            .andThen((token) => issue(repo, token))
            .map((repoToken) => repoToken.token),
        fetch: fetchImpl,
        api: GITHUB_API,
        userAgent: USER_AGENT,
      }),
      () => readerBaseBranch(reader, factoryBaseBranchOf),
    );

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

    getIssue: (reader, issueNumber) => reads(reader).getIssue(issueNumber),
    issueBlockers: (reader, issueNumber) => reads(reader).blockers(issueNumber),
    listDefaultBranchDir: (reader, path) => reads(reader).listDefaultBranchDir(path),
    readDefaultBranchFile: (reader, path) => reads(reader).readDefaultBranchFile(path),
    defaultBranchHead: (reader) => reads(reader).defaultBranchHead(),
    readFileAt: (reader, path, ref) => reads(reader).readFileAt(path, ref),
    findPullRequest: (reader, branch, state) => reads(reader).findPullRequest(branch, state),
    branchAhead: (reader, branch) => reads(reader).branchAhead(branch),
    defaultBranch: (reader) => reads(reader).defaultBranch(),
    relabelIssue: (reader, issueNumber, labels) => reads(reader).relabelIssue(issueNumber, labels),
    commentOnIssue: (reader, issueNumber, body) => reads(reader).commentOnIssue(issueNumber, body),
    createIssue: (reader, issue) => reads(reader).createIssue(issue),
    closeIssue: (reader, issueNumber) => reads(reader).closeIssue(issueNumber),
    ensureBranch: (reader, branch) => reads(reader).ensureBranch(branch),
    branchContains: (reader, branch, sha) => reads(reader).branchContains(branch, sha),
    mergeCommit: (reader, number) => reads(reader).mergeCommit(number),
    branchState: (reader, branch) => reads(reader).branchState(branch),
    mergeCommitState: (reader, number) => reads(reader).mergeCommitState(number),
    issueText: (reader, issueNumber) => reads(reader).issueText(issueNumber),
    revertPullRequest: (reader, number, text) => reads(reader).revertPullRequest(number, text),

    pullRequests: createFactoryPullRequests({
      issue,
      ownerToken,
      issueCheckPublisher: (repo, token) => tokenIssuer.issueCheckPublisher(repo, token),
      issueStatusPublisher: (repo, token) => tokenIssuer.issueStatusPublisher(repo, token),
      appId: () => tokenIssuer.appId(),
      fetch: fetchImpl,
    }),
  };
}
