/**
 * GitHub CLI wrappers for PR review operations.
 *
 * Uses `gh` CLI via `execute()` from process.ts.
 * Returns ResultAsync<T, DomainError> per codebase convention.
 */

import { processError, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { execute, ProcessExecutionError } from './process.js';

// ── Types ────────────────────────────────────────────────────

export interface PRReview {
  id: number;
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  body: string;
  submittedAt: string;
}

export interface PRReviewComment {
  id: number;
  author: string;
  body: string;
  path: string;
  line: number | null;
}

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | '';

export interface PRReviewData {
  reviews: PRReview[];
  comments: PRReviewComment[];
  reviewDecision: ReviewDecision;
}

export interface PRInfo {
  number: number;
  title: string;
  body: string;
  author: string;
  headBranch: string;
  baseBranch: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface BranchPRInfo {
  prNumber: number;
  prUrl: string;
  prState: 'OPEN' | 'MERGED' | 'CLOSED';
}

function branchHeadRefName(branch: string): string {
  const ownerSeparator = branch.indexOf(':');
  return ownerSeparator === -1 ? branch : branch.slice(ownerSeparator + 1);
}

// ── Functions ────────────────────────────────────────────────

/**
 * Fetch PR reviews and inline comments via `gh pr view`.
 */
export function fetchPRReviews(
  cwd: string,
  prNumber: number,
): ResultAsync<PRReviewData, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const result = await execute(
        'gh',
        ['pr', 'view', String(prNumber), '--json', 'reviews,comments,reviewDecision'],
        { cwd, timeout: 30_000, reject: false },
      );

      if (result.exitCode !== 0) {
        throw new Error(`gh pr view failed: ${result.stderr || result.stdout}`);
      }

      const data = JSON.parse(result.stdout);

      const reviews: PRReview[] = (data.reviews ?? []).map((r: any) => ({
        id: r.id ?? 0,
        author: r.author?.login ?? '',
        state: r.state ?? 'COMMENTED',
        body: r.body ?? '',
        submittedAt: r.submittedAt ?? '',
      }));

      const comments: PRReviewComment[] = (data.comments ?? []).map((c: any) => ({
        id: c.id ?? 0,
        author: c.author?.login ?? '',
        body: c.body ?? '',
        path: c.path ?? '',
        line: c.line ?? null,
      }));

      const reviewDecision: ReviewDecision = data.reviewDecision ?? '';

      return { reviews, comments, reviewDecision };
    })(),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  );
}

/**
 * Check if a PR is approved via `gh pr view --json reviewDecision`.
 */
export function checkPRApprovalStatus(
  cwd: string,
  prNumber: number,
): ResultAsync<ReviewDecision, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const result = await execute(
        'gh',
        ['pr', 'view', String(prNumber), '--json', 'reviewDecision'],
        { cwd, timeout: 15_000, reject: false },
      );

      if (result.exitCode !== 0) {
        throw new Error(`gh pr view failed: ${result.stderr || result.stdout}`);
      }

      const data = JSON.parse(result.stdout);
      return (data.reviewDecision ?? '') as ReviewDecision;
    })(),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  );
}

/**
 * Merge a PR via `gh pr merge`.
 */
export function mergePR(
  cwd: string,
  prNumber: number,
  method: 'squash' | 'merge' | 'rebase' = 'squash',
): ResultAsync<string, DomainError> {
  const methodFlag = `--${method}`;
  return ResultAsync.fromPromise(
    execute('gh', ['pr', 'merge', String(prNumber), methodFlag], {
      cwd,
      timeout: 30_000,
    }).then((r) => r.stdout.trim()),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  );
}

/**
 * Fetch PR metadata via `gh pr view --json`.
 */
export function getPRInfo(cwd: string, prNumber: number): ResultAsync<PRInfo, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const result = await execute(
        'gh',
        [
          'pr',
          'view',
          String(prNumber),
          '--json',
          'number,title,body,author,headRefName,baseRefName,additions,deletions,changedFiles',
        ],
        { cwd, timeout: 30_000, reject: false },
      );

      if (result.exitCode !== 0) {
        throw new Error(`gh pr view failed: ${result.stderr || result.stdout}`);
      }

      const data = JSON.parse(result.stdout);
      return {
        number: data.number ?? prNumber,
        title: data.title ?? '',
        body: data.body ?? '',
        author: data.author?.login ?? '',
        headBranch: data.headRefName ?? '',
        baseBranch: data.baseRefName ?? '',
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
        changedFiles: data.changedFiles ?? 0,
      } as PRInfo;
    })(),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  );
}

/**
 * Fetch the unified diff of a PR via `gh pr diff`.
 */
export function getPRDiff(cwd: string, prNumber: number): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const result = await execute('gh', ['pr', 'diff', String(prNumber)], {
        cwd,
        timeout: 60_000,
        reject: false,
      });

      if (result.exitCode !== 0) {
        throw new Error(`gh pr diff failed: ${result.stderr || result.stdout}`);
      }

      return result.stdout;
    })(),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  );
}

/**
 * Post a review on a PR via `gh pr review`.
 */
export function postPRReview(
  cwd: string,
  prNumber: number,
  body: string,
  event: ReviewEvent,
): ResultAsync<string, DomainError> {
  const flagMap: Record<ReviewEvent, string> = {
    APPROVE: '--approve',
    REQUEST_CHANGES: '--request-changes',
    COMMENT: '--comment',
  };

  return ResultAsync.fromPromise(
    execute('gh', ['pr', 'review', String(prNumber), flagMap[event], '--body', body], {
      cwd,
      timeout: 30_000,
    }).then((r) => r.stdout.trim()),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  );
}

/**
 * Look up an open PR for a given branch name via `gh pr list --head <branch>`.
 * Returns null when no PR exists or when `gh` is unavailable/unauthenticated.
 * Designed to fail silently — never breaks callers.
 */
// ── Publish Repository ──────────────────────────────────────

export interface PublishRepoOptions {
  name: string;
  description?: string;
  org?: string;
  private: boolean;
}

/**
 * List GitHub organizations the authenticated user belongs to.
 * Requires a valid GH_TOKEN.
 */
export function listGitHubOrgs(
  cwd: string,
  env?: Record<string, string>,
): ResultAsync<string[], DomainError> {
  return ResultAsync.fromPromise(
    execute('gh', ['api', 'user/memberships/orgs', '--jq', '.[].organization.login'], {
      cwd,
      timeout: 15_000,
      reject: false,
      env,
    }).then((r) => {
      if (r.exitCode !== 0) return [];
      return r.stdout.trim().split('\n').filter(Boolean);
    }),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  );
}

/**
 * Publish a local repository to GitHub.
 * Uses `gh repo create` with `--source . --remote origin --push` to create
 * the repo, add the remote, and push in one atomic operation.
 */
export function publishRepo(
  cwd: string,
  options: PublishRepoOptions,
  env?: Record<string, string>,
): ResultAsync<string, DomainError> {
  const repoName = options.org ? `${options.org}/${options.name}` : options.name;
  const args = [
    'repo',
    'create',
    repoName,
    options.private ? '--private' : '--public',
    '--source',
    '.',
    '--remote',
    'origin',
    '--push',
  ];
  if (options.description) {
    args.push('--description', options.description);
  }
  return ResultAsync.fromPromise(
    execute('gh', args, { cwd, timeout: 60_000, env }).then((r) => r.stdout.trim()),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
  );
}

// ── PR Queries ──────────────────────────────────────────────

export async function getPRForBranch(
  cwd: string,
  branch: string,
  env?: Record<string, string>,
): Promise<BranchPRInfo | null> {
  try {
    const result = await execute(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'number,url,state,headRefName',
        '--limit',
        '10',
      ],
      { cwd, timeout: 10_000, reject: false, env },
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;
    const data = JSON.parse(result.stdout);
    if (!Array.isArray(data) || data.length === 0) return null;
    const expectedHeadRef = branchHeadRefName(branch);
    const pr = data.find((candidate) => candidate?.headRefName === expectedHeadRef);
    if (!pr) return null;
    return {
      prNumber: pr.number,
      prUrl: pr.url,
      prState: pr.state ?? 'OPEN',
    };
  } catch {
    return null;
  }
}
