import { ok, err, ResultAsync, type Result } from 'neverthrow';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execute, executeSync, ProcessExecutionError } from './process.js';
import { validatePath, validatePathSync } from './path-validation.js';
import { processError, internal, badRequest, type DomainError } from '@funny/shared/errors';
import type { FileDiff, FileDiffSummary, DiffSummaryResponse, GitSyncState } from '@funny/shared';

/** Per-user git identity for multi-user mode. */
export interface GitIdentityOptions {
  author?: { name: string; email: string };
  githubToken?: string;
}

/**
 * Execute a git command safely with proper argument escaping.
 * Returns ResultAsync<string, DomainError>.
 */
export function git(args: string[], cwd: string, env?: Record<string, string>): ResultAsync<string, DomainError> {
  return validatePath(cwd).andThen((validCwd) =>
    ResultAsync.fromPromise(
      execute('git', args, { cwd: validCwd, env }),
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
 * Stage files for commit.
 * Filters out gitignored files before running `git add` to prevent
 * the entire operation from failing when ignored files are included.
 */
export function stageFiles(cwd: string, paths: string[]): ResultAsync<void, DomainError> {
  if (paths.length === 0) return new ResultAsync(Promise.resolve(ok(undefined)));

  return ResultAsync.fromPromise(
    (async () => {
      // Ask git which of the requested paths are ignored
      const checkResult = await execute(
        'git', ['check-ignore', '--stdin'],
        { cwd, reject: false, stdin: paths.join('\n') }
      );
      const ignoredSet = new Set(
        checkResult.exitCode === 0 && checkResult.stdout.trim()
          ? checkResult.stdout.trim().split('\n').map(p => p.trim())
          : []
      );

      const filteredPaths = paths.filter(p => !ignoredSet.has(p));
      if (filteredPaths.length === 0) return;

      const addResult = await git(['add', ...filteredPaths], cwd);
      if (addResult.isErr()) throw addResult.error;
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    }
  );
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
 * Add a pattern to .gitignore. Creates the file if it doesn't exist.
 * Avoids adding duplicate entries.
 */
export function addToGitignore(cwd: string, pattern: string): Result<void, DomainError> {
  try {
    const gitignorePath = join(cwd, '.gitignore');
    let content = '';
    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, 'utf-8');
    }
    const lines = content.split('\n');
    if (lines.some(l => l.trim() === pattern.trim())) {
      return ok(undefined);
    }
    const newContent = content.endsWith('\n') || content === ''
      ? content + pattern + '\n'
      : content + '\n' + pattern + '\n';
    writeFileSync(gitignorePath, newContent, 'utf-8');
    return ok(undefined);
  } catch (e) {
    return err(internal(`Failed to update .gitignore: ${String(e)}`));
  }
}

/**
 * Create a commit with a message.
 * When identity.author is provided, adds --author flag for per-user attribution.
 */
export function commit(cwd: string, message: string, identity?: GitIdentityOptions): ResultAsync<string, DomainError> {
  const args = ['commit', '-m', message];
  if (identity?.author) {
    args.push('--author', `${identity.author.name} <${identity.author.email}>`);
  }
  return git(args, cwd);
}

/**
 * Push to remote.
 * When identity.githubToken is provided, passes GH_TOKEN env var for authentication.
 */
export function push(cwd: string, identity?: GitIdentityOptions): ResultAsync<string, DomainError> {
  const env = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
  return getCurrentBranch(cwd).andThen((branch) =>
    git(['push', '-u', 'origin', branch], cwd, env)
  );
}

/**
 * Create a pull request using GitHub CLI.
 * When identity.githubToken is provided, passes GH_TOKEN env var for authentication.
 */
export function createPR(
  cwd: string,
  title: string,
  body: string,
  baseBranch?: string,
  identity?: GitIdentityOptions
): ResultAsync<string, DomainError> {
  const args = ['pr', 'create', '--title', title, '--body', body];
  if (baseBranch) {
    args.push('--base', baseBranch);
  }
  const env = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
  return ResultAsync.fromPromise(
    execute('gh', args, { cwd, timeout: 30_000, env }).then((r) => r.stdout.trim()),
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
 *
 * When worktreePath is provided, the feature branch is rebased onto
 * the target branch first (inside the worktree) so that the merge
 * into the target is always clean. If the rebase hits conflicts it
 * is aborted and the error is returned without touching the target.
 */
export function mergeBranch(
  cwd: string,
  featureBranch: string,
  targetBranch: string,
  identity?: GitIdentityOptions,
  worktreePath?: string,
): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // ── 1. Rebase feature branch onto target (inside worktree) ──
      if (worktreePath) {
        const rebaseResult = await git(['rebase', targetBranch], worktreePath);
        if (rebaseResult.isErr()) {
          await execute('git', ['rebase', '--abort'], { cwd: worktreePath, reject: false });
          throw badRequest(
            `Rebase failed — there are conflicts between your branch and ${targetBranch}. ` +
            `Resolve them in the worktree and try again.`
          );
        }
      }

      // ── 2. Validate main working tree is clean ──
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

      // ── 3. Merge into target ──
      try {
        const checkoutResult = await git(['checkout', targetBranch], cwd);
        if (checkoutResult.isErr()) throw checkoutResult.error;

        const mergeArgs = ['merge', '--no-ff', featureBranch, '-m', `Merge branch '${featureBranch}' into ${targetBranch}`];
        if (identity?.author) {
          mergeArgs.push('--author', `${identity.author.name} <${identity.author.email}>`);
        }
        const mergeResult = await git(mergeArgs, cwd);
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
 * Split a unified diff blob into per-file chunks.
 * Each chunk starts with "diff --git a/... b/..."
 */
function splitDiffByFile(rawDiff: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!rawDiff) return result;

  const chunks = rawDiff.split(/(?=^diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    // Extract path from "diff --git a/foo b/foo"
    const headerMatch = chunk.match(/^diff --git a\/.+ b\/(.+)/);
    if (headerMatch) {
      result.set(headerMatch[1], chunk.trim());
    }
  }
  return result;
}

/**
 * Get diff information for all changed files.
 * Uses only 4 git commands total (instead of N+3 per file).
 */
export function getDiff(cwd: string): ResultAsync<FileDiff[], DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      // Run all 4 commands in parallel — no dependency between them
      const [stagedStatusResult, unstagedStatusResult, untrackedResult, stagedDiffResult, unstagedDiffResult] =
        await Promise.all([
          execute('git', ['diff', '--staged', '--name-status'], { cwd, reject: false }),
          execute('git', ['diff', '--name-status'], { cwd, reject: false }),
          execute('git', ['ls-files', '--others', '--exclude-standard'], { cwd, reject: false }),
          execute('git', ['diff', '--staged'], { cwd, reject: false }),
          execute('git', ['diff'], { cwd, reject: false }),
        ]);

      const stagedRaw = stagedStatusResult.exitCode === 0 ? stagedStatusResult.stdout.trim() : '';
      const stagedFiles = stagedRaw
        .split('\n')
        .filter(Boolean)
        .map(parseStatusLine)
        .filter(Boolean) as { status: FileDiff['status']; path: string }[];

      const unstagedRaw = unstagedStatusResult.exitCode === 0 ? unstagedStatusResult.stdout.trim() : '';
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

      // Parse the full diff blobs into per-file maps
      const stagedDiffMap = splitDiffByFile(
        stagedDiffResult.exitCode === 0 ? stagedDiffResult.stdout : ''
      );
      const unstagedDiffMap = splitDiffByFile(
        unstagedDiffResult.exitCode === 0 ? unstagedDiffResult.stdout : ''
      );

      const stagedPaths = new Set(stagedFiles.map((f) => f.path));
      const diffs: FileDiff[] = [];

      for (const f of stagedFiles) {
        diffs.push({ path: f.path, status: f.status, diff: stagedDiffMap.get(f.path) ?? '', staged: true });
      }

      for (const f of allUnstaged) {
        if (stagedPaths.has(f.path)) continue;
        diffs.push({ path: f.path, status: f.status, diff: unstagedDiffMap.get(f.path) ?? '', staged: false });
      }

      return diffs;
    })(),
    (error) => processError(String(error), 1, '')
  );
}

// ─── Diff Summary (lightweight, no diff content) ────────

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      if (filePath.startsWith(prefix + '/') || filePath === prefix) return true;
    } else if (pattern.startsWith('*')) {
      if (filePath.endsWith(pattern.slice(1))) return true;
    } else if (filePath === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Get file list without diff content — much faster than getDiff().
 * Only runs name-status and ls-files commands (no full diff).
 * No files are excluded by default — relies on lazy diff loading + virtualization on the client.
 */
export function getDiffSummary(
  cwd: string,
  options?: { excludePatterns?: string[]; maxFiles?: number }
): ResultAsync<DiffSummaryResponse, DomainError> {
  const exclude = options?.excludePatterns ?? [];
  const maxFiles = options?.maxFiles ?? 0; // 0 = no limit

  return ResultAsync.fromPromise(
    (async () => {
      const [stagedStatusResult, unstagedStatusResult, untrackedResult] = await Promise.all([
        execute('git', ['diff', '--staged', '--name-status'], { cwd, reject: false }),
        execute('git', ['diff', '--name-status'], { cwd, reject: false }),
        execute('git', ['ls-files', '--others', '--exclude-standard'], { cwd, reject: false }),
      ]);

      const stagedRaw = stagedStatusResult.exitCode === 0 ? stagedStatusResult.stdout.trim() : '';
      const stagedFiles = stagedRaw
        .split('\n')
        .filter(Boolean)
        .map(parseStatusLine)
        .filter(Boolean) as { status: FileDiffSummary['status']; path: string }[];

      const unstagedRaw = unstagedStatusResult.exitCode === 0 ? unstagedStatusResult.stdout.trim() : '';
      const untrackedRaw = untrackedResult.exitCode === 0 ? untrackedResult.stdout.trim() : '';

      const unstagedFiles = unstagedRaw
        .split('\n')
        .filter(Boolean)
        .map(parseStatusLine)
        .filter(Boolean) as { status: FileDiffSummary['status']; path: string }[];

      const untrackedFiles = untrackedRaw
        .split('\n')
        .filter(Boolean)
        .map((p) => ({ status: 'added' as const, path: p.trim() }));

      const allUnstaged = [...unstagedFiles, ...untrackedFiles];
      const stagedPaths = new Set(stagedFiles.map((f) => f.path));

      const allFiles: FileDiffSummary[] = [];

      for (const f of stagedFiles) {
        if (exclude.length > 0 && matchesAnyPattern(f.path, exclude)) continue;
        allFiles.push({ path: f.path, status: f.status, staged: true });
      }
      for (const f of allUnstaged) {
        if (stagedPaths.has(f.path)) continue;
        if (exclude.length > 0 && matchesAnyPattern(f.path, exclude)) continue;
        allFiles.push({ path: f.path, status: f.status, staged: false });
      }

      const total = allFiles.length;
      const truncated = maxFiles > 0 && total > maxFiles;
      const files = truncated ? allFiles.slice(0, maxFiles) : allFiles;

      return { files, total, truncated };
    })(),
    (error) => processError(String(error), 1, '')
  );
}

/**
 * Get the diff content for a single file.
 */
export function getSingleFileDiff(
  cwd: string,
  filePath: string,
  staged: boolean
): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (staged) {
        const result = await execute('git', ['diff', '--staged', '--', filePath], { cwd, reject: false });
        return result.exitCode === 0 ? result.stdout : '';
      }
      // Check if file is untracked
      const lsResult = await execute('git', ['ls-files', '--others', '--exclude-standard', '--', filePath], { cwd, reject: false });
      if (lsResult.exitCode === 0 && lsResult.stdout.trim()) {
        // Untracked file — use diff --no-index
        const result = await execute('git', ['diff', '--no-index', '/dev/null', filePath], { cwd, reject: false });
        // --no-index exits with 1 when there are differences (expected)
        return result.stdout;
      }
      // Tracked, unstaged
      const result = await execute('git', ['diff', '--', filePath], { cwd, reject: false });
      return result.exitCode === 0 ? result.stdout : '';
    })(),
    (error) => processError(String(error), 1, '')
  );
}

// ─── Git Status Summary ─────────────────────────────────

export interface GitStatusSummary {
  dirtyFileCount: number;
  unpushedCommitCount: number;
  hasRemoteBranch: boolean;
  isMergedIntoBase: boolean;
  linesAdded: number;
  linesDeleted: number;
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
        return { dirtyFileCount, unpushedCommitCount: 0, hasRemoteBranch: false, isMergedIntoBase: false, linesAdded: 0, linesDeleted: 0 };
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

      // Get lines added/deleted using git diff --numstat
      let linesAdded = 0;
      let linesDeleted = 0;

      // Count staged changes
      const stagedNumstatResult = await execute(
        'git', ['diff', '--staged', '--numstat'],
        { cwd: worktreeCwd, reject: false }
      );
      if (stagedNumstatResult.exitCode === 0 && stagedNumstatResult.stdout.trim()) {
        const lines = stagedNumstatResult.stdout.trim().split('\n');
        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length >= 2) {
            const added = parseInt(parts[0], 10);
            const deleted = parseInt(parts[1], 10);
            if (!isNaN(added)) linesAdded += added;
            if (!isNaN(deleted)) linesDeleted += deleted;
          }
        }
      }

      // Count unstaged changes
      const unstagedNumstatResult = await execute(
        'git', ['diff', '--numstat'],
        { cwd: worktreeCwd, reject: false }
      );
      if (unstagedNumstatResult.exitCode === 0 && unstagedNumstatResult.stdout.trim()) {
        const lines = unstagedNumstatResult.stdout.trim().split('\n');
        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length >= 2) {
            const added = parseInt(parts[0], 10);
            const deleted = parseInt(parts[1], 10);
            if (!isNaN(added)) linesAdded += added;
            if (!isNaN(deleted)) linesDeleted += deleted;
          }
        }
      }

      return { dirtyFileCount, unpushedCommitCount, hasRemoteBranch, isMergedIntoBase, linesAdded, linesDeleted };
    })(),
    (error) => processError(String(error), 1, '')
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
