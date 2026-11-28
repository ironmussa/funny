/**
 * Factory flow setup commit, push, and pull-request operations on the runner
 * (openspec factory-flow-bootstrap, D4 / Task 3.4).
 *
 * Commits ONLY the exact setup files provided (the flow file and any built-in
 * prompt files), verified against `expectedFlowSha`, pushes
 * `HEAD:refs/heads/<defaultBranch>` without `--force` (rebasing once if the
 * remote moved), and classifies branch-protection / hook rejections so the
 * server can offer the pull-request fallback.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, normalize, resolve } from 'node:path';

import {
  createPullRequest,
  gitRead,
  gitWrite,
  isSafeGitRefArg,
  type CreatedPullRequest,
} from '@funny/core/git';
import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import { log } from '../lib/logger.js';

const ns = 'factory-flow-setup-git';

export interface SetupFileEntry {
  /** Repo-relative path under `.funny/`. */
  path: string;
  /** Exact UTF-8 content to write and commit. */
  content: string;
}

export interface CommitAndPushSetupRequest {
  worktreePath: string;
  defaultBranch: string;
  /** Exact files to commit; `files[0]` is the flow file whose sha is checked. */
  files: SetupFileEntry[];
  /** Expected lowercase hex SHA-256 of `files[0].content`. */
  expectedFlowSha: string;
  commitMessage: string;
  remote?: string;
}

export type CommitAndPushSetupResult =
  | { ok: true; commitSha: string }
  | {
      ok: false;
      kind: 'sha-mismatch' | 'invalid-path' | 'conflict' | 'branch-rule-rejected' | 'push-failed';
      message: string;
    };

export interface OpenSetupPRRequest {
  worktreePath: string;
  setupBranch: string;
  defaultBranch: string;
  title: string;
  body: string;
  githubToken?: string;
  remote?: string;
}

export type OpenSetupPRResult =
  | { ok: true; prUrl: string; prNumber: number | null }
  | { ok: false; message: string };

export interface SetupGitDeps {
  createPullRequest: (
    cwd: string,
    options: {
      title: string;
      body: string;
      baseBranch: string;
      headBranch: string;
      githubToken?: string;
    },
  ) => ResultAsync<CreatedPullRequest, DomainError>;
}

const defaultDeps: SetupGitDeps = {
  createPullRequest,
};

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Validates that a setup file path is strictly relative, normalized, and lives
 * under `.funny/`.
 */
function isSafeSetupFilePath(relPath: string): boolean {
  if (!relPath || relPath.startsWith('/') || relPath.startsWith('\\') || relPath.includes('\0')) {
    return false;
  }
  const normalized = normalize(relPath).replace(/\\/g, '/');
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized === '..') {
    return false;
  }
  return normalized.startsWith('.funny/') && normalized.length > '.funny/'.length;
}

const BRANCH_RULE_PATTERNS = [
  /\bGH006\b/i,
  /\bGH013\b/i,
  /protected branch/i,
  /repository rule violations/i,
  /pre-receive hook declined/i,
  /remote rejected.*hook declined/i,
  /hook declined/i,
  /changes must be made through a pull request/i,
  /required status check/i,
  /branch protection/i,
];

const NON_FAST_FORWARD_PATTERNS = [
  /non-fast-forward/i,
  /fetch first/i,
  /contains work that you do not have locally/i,
  /tip of your current branch is behind/i,
];

function isBranchRuleRejection(output: string): boolean {
  return BRANCH_RULE_PATTERNS.some((re) => re.test(output));
}

function isNonFastForwardRejection(output: string): boolean {
  if (isBranchRuleRejection(output)) return false;
  return NON_FAST_FORWARD_PATTERNS.some((re) => re.test(output));
}

/**
 * Extracts the human-readable `remote:` lines from git push stderr when
 * available, falling back to the trimmed stderr/stdout.
 */
function extractGitPushMessage(stderr: string, stdout: string): string {
  const combined = [stderr, stdout].filter(Boolean).join('\n');
  const remoteLines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^remote:/i.test(line))
    .map((line) => line.replace(/^remote:\s*/i, '').trim())
    .filter((line) => line.length > 0 && !/^(counting|compressing|total|resolving)/i.test(line));
  if (remoteLines.length > 0) {
    return remoteLines.join('\n').slice(0, 2000);
  }
  return combined.trim().slice(0, 2000) || 'git push failed';
}

async function resolveHeadSha(cwd: string): Promise<string> {
  const head = await gitRead(['rev-parse', 'HEAD'], { cwd, reject: false });
  return head.exitCode === 0 ? head.stdout.trim() : '';
}

/**
 * Commits ONLY `request.files` on the setup worktree's current branch and
 * pushes `HEAD:refs/heads/<defaultBranch>` without force.
 *
 * If the remote moved (non-fast-forward), fetches and rebases the setup commit
 * onto `<remote>/<defaultBranch>` once, then retries the push.
 */
export async function commitAndPushSetup(
  request: CommitAndPushSetupRequest,
): Promise<CommitAndPushSetupResult> {
  const remote = request.remote ?? 'origin';

  if (!isSafeGitRefArg(request.defaultBranch) || !isSafeGitRefArg(remote)) {
    return { ok: false, kind: 'invalid-path', message: 'Invalid git branch or remote name' };
  }
  if (request.files.length === 0) {
    return { ok: false, kind: 'invalid-path', message: 'No setup files provided' };
  }

  for (const file of request.files) {
    if (!isSafeSetupFilePath(file.path)) {
      return {
        ok: false,
        kind: 'invalid-path',
        message: `Refusing to commit path outside .funny/: ${file.path}`,
      };
    }
  }

  const actualSha = sha256Hex(request.files[0]!.content);
  if (actualSha !== request.expectedFlowSha) {
    return {
      ok: false,
      kind: 'sha-mismatch',
      message: `Flow file digest mismatch (expected ${request.expectedFlowSha.slice(0, 12)}, got ${actualSha.slice(0, 12)})`,
    };
  }

  const cwd = request.worktreePath;

  // Discard any unrelated agent edits or canary files before staging only the
  // approved setup files.
  const reset = await gitWrite(['reset', '--hard', 'HEAD'], { cwd, reject: false });
  if (reset.exitCode !== 0) {
    return {
      ok: false,
      kind: 'push-failed',
      message: `Failed to clean setup worktree: ${reset.stderr.trim() || reset.stdout.trim()}`,
    };
  }
  await gitWrite(['clean', '-fd'], { cwd, reject: false });

  // Write ONLY the exact setup files.
  const relPaths: string[] = [];
  for (const file of request.files) {
    const normalizedRel = normalize(file.path).replace(/\\/g, '/');
    const absPath = resolve(cwd, normalizedRel);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, file.content, 'utf8');
    relPaths.push(normalizedRel);
  }

  // Stage only the exact setup paths.
  const add = await gitWrite(['add', '--', ...relPaths], { cwd, reject: false });
  if (add.exitCode !== 0) {
    return {
      ok: false,
      kind: 'push-failed',
      message: `Failed to stage setup files: ${add.stderr.trim() || add.stdout.trim()}`,
    };
  }

  // Commit if there are staged changes (idempotent if retrying after a failed push).
  const diffCached = await gitRead(['diff', '--cached', '--quiet'], { cwd, reject: false });
  if (diffCached.exitCode !== 0) {
    const commitRes = await gitWrite(['commit', '-m', request.commitMessage, '--', ...relPaths], {
      cwd,
      reject: false,
    });
    if (commitRes.exitCode !== 0) {
      return {
        ok: false,
        kind: 'push-failed',
        message: `Failed to commit setup files: ${commitRes.stderr.trim() || commitRes.stdout.trim()}`,
      };
    }
  }

  const refspec = `HEAD:refs/heads/${request.defaultBranch}`;

  const attemptPush = async () =>
    gitWrite(['push', remote, refspec], { cwd, reject: false, timeout: 60_000 });

  let pushRes = await attemptPush();
  if (pushRes.exitCode === 0) {
    const commitSha = await resolveHeadSha(cwd);
    log.info('Committed and pushed factory setup', {
      namespace: ns,
      defaultBranch: request.defaultBranch,
      commitSha,
    });
    return { ok: true, commitSha };
  }

  const firstOutput = `${pushRes.stderr}\n${pushRes.stdout}`;
  if (isNonFastForwardRejection(firstOutput)) {
    log.info('Default branch moved; rebasing setup commit once', {
      namespace: ns,
      defaultBranch: request.defaultBranch,
    });
    const fetchRes = await gitWrite(['fetch', remote, request.defaultBranch], {
      cwd,
      reject: false,
      timeout: 60_000,
    });
    if (fetchRes.exitCode !== 0) {
      return {
        ok: false,
        kind: 'push-failed',
        message: `Failed to fetch ${remote}/${request.defaultBranch}: ${extractGitPushMessage(fetchRes.stderr, fetchRes.stdout)}`,
      };
    }

    const rebaseRes = await gitWrite(['rebase', `${remote}/${request.defaultBranch}`], {
      cwd,
      reject: false,
    });
    if (rebaseRes.exitCode !== 0) {
      await gitWrite(['rebase', '--abort'], { cwd, reject: false });
      return {
        ok: false,
        kind: 'conflict',
        message: `Rebase onto ${remote}/${request.defaultBranch} conflicted: ${extractGitPushMessage(rebaseRes.stderr, rebaseRes.stdout)}`,
      };
    }

    pushRes = await attemptPush();
    if (pushRes.exitCode === 0) {
      const commitSha = await resolveHeadSha(cwd);
      log.info('Committed and pushed factory setup after rebase', {
        namespace: ns,
        defaultBranch: request.defaultBranch,
        commitSha,
      });
      return { ok: true, commitSha };
    }
  }

  const finalOutput = `${pushRes.stderr}\n${pushRes.stdout}`;
  const message = extractGitPushMessage(pushRes.stderr, pushRes.stdout);
  if (isBranchRuleRejection(finalOutput)) {
    log.info('Direct push rejected by branch rule', {
      namespace: ns,
      defaultBranch: request.defaultBranch,
      message,
    });
    return { ok: false, kind: 'branch-rule-rejected', message };
  }

  return { ok: false, kind: 'push-failed', message };
}

/**
 * Pushes the setup branch to origin and opens a pull request to the default
 * branch using the member's token via `@funny/core/git`'s `createPullRequest`.
 */
export async function pushSetupBranchAndOpenPR(
  request: OpenSetupPRRequest,
  deps: SetupGitDeps = defaultDeps,
): Promise<OpenSetupPRResult> {
  const remote = request.remote ?? 'origin';
  if (
    !isSafeGitRefArg(request.setupBranch) ||
    !isSafeGitRefArg(request.defaultBranch) ||
    !isSafeGitRefArg(remote)
  ) {
    return { ok: false, message: 'Invalid git branch or remote name' };
  }

  const cwd = request.worktreePath;
  const pushRes = await gitWrite(['push', '-u', remote, `HEAD:refs/heads/${request.setupBranch}`], {
    cwd,
    reject: false,
    timeout: 60_000,
  });
  if (pushRes.exitCode !== 0) {
    return {
      ok: false,
      message: `Failed to push setup branch ${request.setupBranch}: ${extractGitPushMessage(pushRes.stderr, pushRes.stdout)}`,
    };
  }

  const prResult = await deps.createPullRequest(cwd, {
    title: request.title,
    body: request.body,
    baseBranch: request.defaultBranch,
    headBranch: request.setupBranch,
    githubToken: request.githubToken,
  });

  if (prResult.isErr()) {
    return { ok: false, message: prResult.error.message };
  }

  log.info('Opened factory setup pull request', {
    namespace: ns,
    setupBranch: request.setupBranch,
    prUrl: prResult.value.prUrl,
    prNumber: prResult.value.prNumber,
  });

  return {
    ok: true,
    prUrl: prResult.value.prUrl,
    prNumber: prResult.value.prNumber,
  };
}
