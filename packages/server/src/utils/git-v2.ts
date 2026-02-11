import { ok, err, ResultAsync } from 'neverthrow';
import { execute, executeSync, ProcessExecutionError } from './process.js';
import { validatePath, validatePathSync } from './path-validation.js';
import { processError, internal, badRequest, type DomainError } from '@a-parallel/shared/errors';
import type { FileDiff, GitSyncState } from '@a-parallel/shared';

/**
 * Execute a git command safely with proper argument escaping.
 * Returns ResultAsync<string, DomainError>.
 */
export function git(args: string[], cwd: string): ResultAsync<string, DomainError> {
  return validatePath(cwd).andThen((validCwd) =>
    ResultAsync.fromPromise(
      execute('git', args, { cwd: validCwd }),
      (error) => {
        if (error instanceof ProcessExecutionError) {
          return processError(error.message, error.exitCode, error.stderr);
        }
        return internal(String(error));
      }
    ).map((result) => result.stdout.trim())
  );
}

/**
 * Internal helper: git command that returns null on failure instead of Err.
 * Used for non-critical operations (branch listing, status checks, etc.).
 */
function gitOptional(args: string[], cwd: string): Promise<string | null> {
  return execute('git', args, { cwd, reject: false })
    .then((r) => (r.exitCode === 0 && r.stdout.trim()) ? r.stdout.trim() : null)
    .catch(() => null);
}

/**
 * Check if a path is a git repository
 */
export async function isGitRepo(path: string): Promise<boolean> {
  const result = await gitOptional(['rev-parse', '--is-inside-work-tree'], path);
  return result === 'true';
}

/**
 * Execute a git command synchronously (use only when necessary, e.g. startup validation)
 */
export function gitSync(args: string[], cwd: string): string {
  validatePathSync(cwd);
  const { stdout } = executeSync('git', args, { cwd });
  return stdout.trim();
}

/**
 * Execute a git command synchronously that may fail without throwing
 */
export function gitSafeSync(args: string[], cwd: string): string | null {
  try {
    return gitSync(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Check if a path is a git repository (synchronous version)
 */
export function isGitRepoSync(path: string): boolean {
  const result = gitSafeSync(['rev-parse', '--is-inside-work-tree'], path);
  return result === 'true';
}

/**
 * Get the current branch name
 */
export function getCurrentBranch(cwd: string): ResultAsync<string, DomainError> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

/**
 * List all branches in the repository.
 * Falls back to remote branches if no local branches exist.
 */
export function listBranches(cwd: string): ResultAsync<string[], DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Try local branches first
      const localOutput = await gitOptional(['branch', '--format=%(refname:short)'], cwd);
      if (localOutput) {
        const locals = localOutput.split('\n').map((b) => b.trim()).filter(Boolean);
        if (locals.length > 0) return locals;
      }

      // Fall back to remote tracking branches
      const remoteOutput = await gitOptional(['branch', '-r', '--format=%(refname:short)'], cwd);
      if (remoteOutput) {
        const remotes = remoteOutput
          .split('\n')
          .map((b) => b.trim())
          .filter((b) => b && !b.includes('HEAD'))
          .map((b) => b.replace(/^origin\//, ''));
        if (remotes.length > 0) return [...new Set(remotes)];
      }

      return [];
    })(),
    (error) => internal(String(error))
  );
}

/**
 * Detect the default branch of the repository.
 */
export function getDefaultBranch(cwd: string): ResultAsync<string | null, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const remoteHead = await gitOptional(
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        cwd
      );
      if (remoteHead) {
        return remoteHead.replace(/^origin\//, '');
      }

      const branchesResult = await listBranches(cwd);
      if (branchesResult.isErr()) return null;
      const branches = branchesResult.value;
      if (branches.includes('main')) return 'main';
      if (branches.includes('master')) return 'master';
      if (branches.includes('develop')) return 'develop';

      return branches.length > 0 ? branches[0] : null;
    })(),
    (error) => internal(String(error))
  );
}

/**
 * Get the remote URL for origin
 */
export function getRemoteUrl(cwd: string): ResultAsync<string | null, DomainError> {
  return ResultAsync.fromPromise(
    gitOptional(['remote', 'get-url', 'origin'], cwd),
    (error) => internal(String(error))
  );
}

/**
 * Extract repository name from remote URL
 */
export function extractRepoName(remoteUrl: string): string {
  return (
    remoteUrl
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .pop() || ''
  );
}

/**
 * Initialize a new git repository
 */
export function initRepo(cwd: string): ResultAsync<void, DomainError> {
  return git(['init'], cwd).map(() => undefined);
}

/**
 * Stage files for commit
 */
export function stageFiles(cwd: string, paths: string[]): ResultAsync<void, DomainError> {
  if (paths.length === 0) return new ResultAsync(Promise.resolve(ok(undefined)));
  return git(['add', ...paths], cwd).map(() => undefined);
}

/**
 * Unstage files
 */
export function unstageFiles(cwd: string, paths: string[]): ResultAsync<void, DomainError> {
  if (paths.length === 0) return new ResultAsync(Promise.resolve(ok(undefined)));

  return ResultAsync.fromPromise(
    (async () => {
      for (const path of paths) {
        const result = await git(['restore', '--staged', path], cwd);
        if (result.isErr()) throw result.error;
      }
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    }
  );
}

/**
 * Revert changes to files
 */
export function revertFiles(cwd: string, paths: string[]): ResultAsync<void, DomainError> {
  if (paths.length === 0) return new ResultAsync(Promise.resolve(ok(undefined)));

  return ResultAsync.fromPromise(
    (async () => {
      for (const path of paths) {
        const result = await git(['checkout', '--', path], cwd);
        if (result.isErr()) throw result.error;
      }
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    }
  );
}

/**
 * Create a commit with a message
 */
export function commit(cwd: string, message: string): ResultAsync<string, DomainError> {
  return git(['commit', '-m', message], cwd);
}

/**
 * Push to remote
 */
export function push(cwd: string): ResultAsync<string, DomainError> {
  return getCurrentBranch(cwd).andThen((branch) =>
    git(['push', '-u', 'origin', branch], cwd)
  );
}

/**
 * Create a pull request using GitHub CLI
 */
export function createPR(
  cwd: string,
  title: string,
  body: string,
  baseBranch?: string
): ResultAsync<string, DomainError> {
  const args = ['pr', 'create', '--title', title, '--body', body];
  if (baseBranch) {
    args.push('--base', baseBranch);
  }
  return ResultAsync.fromPromise(
    execute('gh', args, { cwd, timeout: 30_000 }).then((r) => r.stdout.trim()),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    }
  );
}

/**
 * Merge a feature branch into a target branch.
 * Must be run from the main repo directory (not a worktree).
 */
export function mergeBranch(
  cwd: string,
  featureBranch: string,
  targetBranch: string
): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const statusResult = await git(['status', '--porcelain'], cwd);
      if (statusResult.isErr()) throw statusResult.error;
      if (statusResult.value.trim()) {
        throw badRequest(
          'Cannot merge: the main working tree has uncommitted changes. Please commit or stash changes first.'
        );
      }

      const branchResult = await getCurrentBranch(cwd);
      if (branchResult.isErr()) throw branchResult.error;
      const originalBranch = branchResult.value;

      try {
        const checkoutResult = await git(['checkout', targetBranch], cwd);
        if (checkoutResult.isErr()) throw checkoutResult.error;

        const mergeResult = await git(
          ['merge', '--no-ff', featureBranch, '-m', `Merge branch '${featureBranch}' into ${targetBranch}`],
          cwd
        );
        if (mergeResult.isErr()) throw mergeResult.error;
        return mergeResult.value;
      } catch (error) {
        await execute('git', ['merge', '--abort'], { cwd, reject: false });
        await execute('git', ['checkout', originalBranch], { cwd, reject: false });
        throw error;
      }
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    }
  );
}

/**
 * Parse git status line to extract file status
 */
function parseStatusLine(line: string): {
  status: FileDiff['status'];
  path: string;
} | null {
  const match = line.match(/^([MADR?])\s+(.+)$/);
  if (!match) return null;

  const statusMap: Record<string, FileDiff['status']> = {
    A: 'added',
    M: 'modified',
    D: 'deleted',
    R: 'renamed',
    '?': 'added',
  };

  return {
    status: statusMap[match[1]] ?? 'modified',
    path: match[2].trim(),
  };
}

/**
 * Get diff information for all changed files
 */
export function getDiff(cwd: string): ResultAsync<FileDiff[], DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const stagedResult = await execute('git', ['diff', '--staged', '--name-status'], { cwd, reject: false });
      const stagedRaw = stagedResult.exitCode === 0 ? stagedResult.stdout.trim() : '';
      const stagedFiles = stagedRaw
        .split('\n')
        .filter(Boolean)
        .map(parseStatusLine)
        .filter(Boolean) as { status: FileDiff['status']; path: string }[];

      const unstagedResult = await execute('git', ['diff', '--name-status'], { cwd, reject: false });
      const unstagedRaw = unstagedResult.exitCode === 0 ? unstagedResult.stdout.trim() : '';
      const untrackedResult = await execute('git', ['ls-files', '--others', '--exclude-standard'], { cwd, reject: false });
      const untrackedRaw = untrackedResult.exitCode === 0 ? untrackedResult.stdout.trim() : '';

      const unstagedFiles = unstagedRaw
        .split('\n')
        .filter(Boolean)
        .map(parseStatusLine)
        .filter(Boolean) as { status: FileDiff['status']; path: string }[];

      const untrackedFiles = untrackedRaw
        .split('\n')
        .filter(Boolean)
        .map((p) => ({ status: 'added' as const, path: p.trim() }));

      const allUnstaged = [...unstagedFiles, ...untrackedFiles];

      const diffs: FileDiff[] = [];

      for (const f of stagedFiles) {
        const diffResult = await execute('git', ['diff', '--staged', '--', f.path], { cwd, reject: false });
        const diffText = diffResult.exitCode === 0 ? diffResult.stdout.trim() : '';
        diffs.push({ path: f.path, status: f.status, diff: diffText, staged: true });
      }

      for (const f of allUnstaged) {
        if (stagedFiles.some((s) => s.path === f.path)) continue;
        const diffResult = await execute('git', ['diff', '--', f.path], { cwd, reject: false });
        const diffText = diffResult.exitCode === 0 ? diffResult.stdout.trim() : '';
        diffs.push({ path: f.path, status: f.status, diff: diffText, staged: false });
      }

      return diffs;
    })(),
    (error) => internal(String(error))
  );
}

// ─── Git Status Summary ─────────────────────────────────

export interface GitStatusSummary {
  dirtyFileCount: number;
  unpushedCommitCount: number;
  hasRemoteBranch: boolean;
  isMergedIntoBase: boolean;
}

/**
 * Get a summary of the git status for a worktree.
 */
export function getStatusSummary(
  worktreeCwd: string,
  baseBranch?: string,
  projectCwd?: string
): ResultAsync<GitStatusSummary, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const porcelainResult = await execute('git', ['status', '--porcelain'], { cwd: worktreeCwd, reject: false });
      const porcelain = porcelainResult.exitCode === 0 ? porcelainResult.stdout.trim() : '';
      const dirtyFileCount = porcelain.split('\n').filter(Boolean).length;

      const branchResult = await getCurrentBranch(worktreeCwd);
      if (branchResult.isErr()) {
        return { dirtyFileCount, unpushedCommitCount: 0, hasRemoteBranch: false, isMergedIntoBase: false };
      }
      const branch = branchResult.value;

      const remoteResult = await execute(
        'git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
        { cwd: worktreeCwd, reject: false }
      );
      const remoteBranch = remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : null;
      const hasRemoteBranch = remoteBranch !== null;

      let unpushedCommitCount = 0;
      if (hasRemoteBranch) {
        const countResult = await execute(
          'git', ['rev-list', '--count', `${remoteBranch}..HEAD`],
          { cwd: worktreeCwd, reject: false }
        );
        unpushedCommitCount = countResult.exitCode === 0 ? (parseInt(countResult.stdout.trim(), 10) || 0) : 0;
      } else if (baseBranch) {
        const countResult = await execute(
          'git', ['rev-list', '--count', `${baseBranch}..HEAD`],
          { cwd: worktreeCwd, reject: false }
        );
        unpushedCommitCount = countResult.exitCode === 0 ? (parseInt(countResult.stdout.trim(), 10) || 0) : 0;
      }

      let isMergedIntoBase = false;
      if (baseBranch && projectCwd) {
        const mergedResult = await execute(
          'git', ['branch', '--merged', baseBranch, '--format=%(refname:short)'],
          { cwd: projectCwd, reject: false }
        );
        if (mergedResult.exitCode === 0 && mergedResult.stdout.trim()) {
          isMergedIntoBase = mergedResult.stdout.trim()
            .split('\n')
            .map((b) => b.trim())
            .includes(branch);
        }
      }

      return { dirtyFileCount, unpushedCommitCount, hasRemoteBranch, isMergedIntoBase };
    })(),
    (error) => internal(String(error))
  );
}

/**
 * Derive a single sync state from a git status summary.
 */
export function deriveGitSyncState(summary: GitStatusSummary): GitSyncState {
  if (summary.isMergedIntoBase) return 'merged';
  if (summary.dirtyFileCount > 0) return 'dirty';
  if (summary.unpushedCommitCount > 0) return 'unpushed';
  if (summary.hasRemoteBranch) return 'pushed';
  return 'clean';
}
