import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { FileDiff, FileDiffSummary, DiffSummaryResponse, GitSyncState } from '@funny/shared';
import { processError, internal, badRequest, type DomainError } from '@funny/shared/errors';
import { ok, err, ResultAsync, type Result } from 'neverthrow';

import { getNativeGit } from './native.js';
import { validatePath, validatePathSync } from './path-validation.js';
import { execute, executeSync, gitRead, gitWrite, ProcessExecutionError } from './process.js';

/** Per-user git identity for multi-user mode. */
export interface GitIdentityOptions {
  author?: { name: string; email: string };
  githubToken?: string;
}

/**
 * Execute a git command safely with proper argument escaping.
 * Returns ResultAsync<string, DomainError>.
 */
export function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): ResultAsync<string, DomainError> {
  return validatePath(cwd).andThen((validCwd) =>
    ResultAsync.fromPromise(gitWrite(args, { cwd: validCwd, env }), (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    }).map((result) => result.stdout.trim()),
  );
}

/**
 * Internal helper: git command that returns null on failure instead of Err.
 * Used for non-critical operations (branch listing, status checks, etc.).
 */
function gitOptional(args: string[], cwd: string): Promise<string | null> {
  return gitRead(args, { cwd, reject: false })
    .then((r) => (r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null))
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
 * Get the current branch name.
 */
export function getCurrentBranch(cwd: string): ResultAsync<string, DomainError> {
  const native = getNativeGit();
  if (!native)
    return new ResultAsync(Promise.resolve(err(internal('Native git module not available'))));
  return ResultAsync.fromPromise(
    native.getCurrentBranch(cwd).then((b) => b ?? ''),
    (error) => processError(String(error), 1, ''),
  );
}

/**
 * List all branches in the repository.
 * Falls back to remote branches if no local branches exist.
 */
export function listBranches(cwd: string): ResultAsync<string[], DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(native.listBranches(cwd), (error) =>
      processError(String(error), 1, ''),
    );
  }
  return ResultAsync.fromPromise(
    (async () => {
      // Try local branches first
      const localOutput = await gitOptional(['branch', '--format=%(refname:short)'], cwd);
      if (localOutput) {
        const locals = localOutput
          .split('\n')
          .map((b) => b.trim())
          .filter(Boolean);
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

      // Fall back to symbolic-ref for empty repos (no commits yet)
      const symbolicBranch = await gitOptional(['symbolic-ref', '--short', 'HEAD'], cwd);
      if (symbolicBranch) return [symbolicBranch];

      return [];
    })(),
    (error) => internal(String(error)),
  );
}

/**
 * Detect the default branch of the repository.
 */
export function getDefaultBranch(cwd: string): ResultAsync<string | null, DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(native.getDefaultBranch(cwd), (error) =>
      processError(String(error), 1, ''),
    );
  }
  return ResultAsync.fromPromise(
    (async () => {
      const remoteHead = await gitOptional(
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        cwd,
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
    (error) => internal(String(error)),
  );
}

/**
 * Get the remote URL for origin
 */
export function getRemoteUrl(cwd: string): ResultAsync<string | null, DomainError> {
  return ResultAsync.fromPromise(gitOptional(['remote', 'get-url', 'origin'], cwd), (error) =>
    internal(String(error)),
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
      const checkResult = await gitRead(['check-ignore', '--stdin'], {
        cwd,
        reject: false,
        stdin: paths.join('\n'),
      });
      const ignoredSet = new Set(
        checkResult.exitCode === 0 && checkResult.stdout.trim()
          ? checkResult.stdout
              .trim()
              .split('\n')
              .map((p) => p.trim())
          : [],
      );

      const filteredPaths = paths.filter((p) => !ignoredSet.has(p));
      if (filteredPaths.length === 0) return;

      const addResult = await git(['add', ...filteredPaths], cwd);
      if (addResult.isErr()) throw addResult.error;
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      return internal(String(error));
    },
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
    },
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
    },
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
    if (lines.some((l) => l.trim() === pattern.trim())) {
      return ok(undefined);
    }
    const newContent =
      content.endsWith('\n') || content === ''
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
 * When amend is true, amends the last commit instead of creating a new one.
 *
 * On Windows, hook output (lint errors, etc.) is often lost because it goes to the
 * console rather than through git's piped stdout/stderr. To capture it, we wrap the
 * pre-commit hook with a script that tees output to a temp file.
 */
export function commit(
  cwd: string,
  message: string,
  identity?: GitIdentityOptions,
  amend?: boolean,
): ResultAsync<string, DomainError> {
  const args = ['commit', '-m', message];
  if (amend) args.push('--amend');
  if (identity?.author) {
    args.push('--author', `${identity.author.name} <${identity.author.email}>`);
  }

  // Set up hook wrapper to capture pre-commit output
  const hookWrapper = createHookWrapper(cwd);
  if (hookWrapper) {
    args.unshift('-c', `core.hooksPath=${hookWrapper.dir.replace(/\\/g, '/')}`);
  }

  return git(args, cwd).mapErr((error) => {
    // Read captured hook output and clean up
    if (hookWrapper) {
      const hookOutput = readHookOutput(hookWrapper.outputFile);
      cleanupHookWrapper(hookWrapper.dir);
      if (hookOutput && error.type === 'PROCESS_ERROR') {
        return processError(error.message, error.exitCode, hookOutput);
      }
    }
    return error;
  });
}

/**
 * Create a temporary hooks directory with a wrapper that captures pre-commit output.
 * Returns null if no pre-commit hook exists.
 */
function createHookWrapper(cwd: string): { dir: string; outputFile: string } | null {
  // Find the original hook
  const hookCandidates = [
    join(cwd, '.husky', 'pre-commit'),
    join(cwd, '.git', 'hooks', 'pre-commit'),
  ];
  let originalHook: string | null = null;
  for (const h of hookCandidates) {
    if (existsSync(h)) {
      originalHook = h;
      break;
    }
  }
  if (!originalHook) return null;

  const id = `git-hook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wrapperDir = join(tmpdir(), id);
  const outputFile = join(tmpdir(), `${id}-output.log`);

  try {
    mkdirSync(wrapperDir, { recursive: true });
    const hookPath = originalHook.replace(/\\/g, '/');
    const outPath = outputFile.replace(/\\/g, '/');
    // Wrapper script: runs the original hook, tees all output to a temp file
    const wrapper = `#!/bin/sh
"${hookPath}" 2>&1 | tee "${outPath}"
exit \${PIPESTATUS[0]:-$?}
`;
    const wrapperFile = join(wrapperDir, 'pre-commit');
    writeFileSync(wrapperFile, wrapper, 'utf-8');
    try {
      chmodSync(wrapperFile, 0o755);
    } catch {
      /* Windows may ignore chmod */
    }
    return { dir: wrapperDir, outputFile };
  } catch {
    return null;
  }
}

function readHookOutput(outputFile: string): string | null {
  try {
    if (!existsSync(outputFile)) return null;
    const content = readFileSync(outputFile, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

function cleanupHookWrapper(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  // Also clean up the output file (which is in tmpdir, not inside the wrapper dir)
  const base = dir.replace(/\\/g, '/').split('/').pop() || '';
  const outputFile = join(tmpdir(), `${base}-output.log`);
  try {
    rmSync(outputFile, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Push to remote.
 * When identity.githubToken is provided, passes GH_TOKEN env var for authentication.
 */
export function push(cwd: string, identity?: GitIdentityOptions): ResultAsync<string, DomainError> {
  const env = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
  return getCurrentBranch(cwd).andThen((branch) => git(['push', '-u', 'origin', branch], cwd, env));
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
  identity?: GitIdentityOptions,
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
    },
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
          await gitWrite(['rebase', '--abort'], { cwd: worktreePath, reject: false });
          throw badRequest(
            `Rebase failed — there are conflicts between your branch and ${targetBranch}. ` +
              `Resolve them in the worktree and try again.`,
          );
        }
      }

      // ── 2. Validate main working tree is clean ──
      const statusResult = await git(['status', '--porcelain'], cwd);
      if (statusResult.isErr()) throw statusResult.error;
      if (statusResult.value.trim()) {
        throw badRequest(
          'Cannot merge: the main working tree has uncommitted changes. Please commit or stash changes first.',
        );
      }

      const branchResult = await getCurrentBranch(cwd);
      if (branchResult.isErr()) throw branchResult.error;
      const originalBranch = branchResult.value;

      // ── 3. Merge into target ──
      try {
        const checkoutResult = await git(['checkout', targetBranch], cwd);
        if (checkoutResult.isErr()) throw checkoutResult.error;

        const mergeArgs = [
          'merge',
          '--no-ff',
          featureBranch,
          '-m',
          `Merge branch '${featureBranch}' into ${targetBranch}`,
        ];
        if (identity?.author) {
          mergeArgs.push('--author', `${identity.author.name} <${identity.author.email}>`);
        }
        const mergeResult = await git(mergeArgs, cwd);
        if (mergeResult.isErr()) throw mergeResult.error;
        return mergeResult.value;
      } catch (error) {
        await gitWrite(['merge', '--abort'], { cwd, reject: false });
        await gitWrite(['checkout', originalBranch], { cwd, reject: false });
        throw error;
      }
    })(),
    (error) => {
      if ((error as DomainError).type) return error as DomainError;
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    },
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
      // Run all 5 read commands in parallel — no dependency between them
      const [
        stagedStatusResult,
        unstagedStatusResult,
        untrackedResult,
        stagedDiffResult,
        unstagedDiffResult,
      ] = await Promise.all([
        gitRead(['diff', '--staged', '--name-status'], { cwd, reject: false }),
        gitRead(['diff', '--name-status'], { cwd, reject: false }),
        gitRead(['ls-files', '--others', '--exclude-standard'], { cwd, reject: false }),
        gitRead(['diff', '--staged'], { cwd, reject: false }),
        gitRead(['diff'], { cwd, reject: false }),
      ]);

      const stagedRaw = stagedStatusResult.exitCode === 0 ? stagedStatusResult.stdout.trim() : '';
      const stagedFiles = stagedRaw
        .split('\n')
        .filter(Boolean)
        .map(parseStatusLine)
        .filter(Boolean) as { status: FileDiff['status']; path: string }[];

      const unstagedRaw =
        unstagedStatusResult.exitCode === 0 ? unstagedStatusResult.stdout.trim() : '';
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
        stagedDiffResult.exitCode === 0 ? stagedDiffResult.stdout : '',
      );
      const unstagedDiffMap = splitDiffByFile(
        unstagedDiffResult.exitCode === 0 ? unstagedDiffResult.stdout : '',
      );

      const stagedPaths = new Set(stagedFiles.map((f) => f.path));
      const diffs: FileDiff[] = [];

      for (const f of stagedFiles) {
        diffs.push({
          path: f.path,
          status: f.status,
          diff: stagedDiffMap.get(f.path) ?? '',
          staged: true,
        });
      }

      for (const f of allUnstaged) {
        if (stagedPaths.has(f.path)) continue;
        diffs.push({
          path: f.path,
          status: f.status,
          diff: unstagedDiffMap.get(f.path) ?? '',
          staged: false,
        });
      }

      return diffs;
    })(),
    (error) => processError(String(error), 1, ''),
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
  options?: { excludePatterns?: string[]; maxFiles?: number },
): ResultAsync<DiffSummaryResponse, DomainError> {
  const native = getNativeGit();
  if (native) {
    const exclude = options?.excludePatterns ?? [];
    const maxFiles = options?.maxFiles ?? 0;
    return ResultAsync.fromPromise(
      native
        .getDiffSummary(cwd, exclude.length > 0 ? exclude : null, maxFiles > 0 ? maxFiles : null)
        .then((r) => ({
          files: r.files.map((f) => ({
            path: f.path,
            status: f.status as FileDiffSummary['status'],
            staged: f.staged,
          })),
          total: r.total,
          truncated: r.truncated,
        })),
      (error) => processError(String(error), 1, ''),
    );
  }
  const exclude = options?.excludePatterns ?? [];
  const maxFiles = options?.maxFiles ?? 0; // 0 = no limit

  return ResultAsync.fromPromise(
    (async () => {
      const [stagedStatusResult, unstagedStatusResult, untrackedResult] = await Promise.all([
        gitRead(['diff', '--staged', '--name-status'], { cwd, reject: false }),
        gitRead(['diff', '--name-status'], { cwd, reject: false }),
        gitRead(['ls-files', '--others', '--exclude-standard'], { cwd, reject: false }),
      ]);

      const stagedRaw = stagedStatusResult.exitCode === 0 ? stagedStatusResult.stdout.trim() : '';
      const stagedFiles = stagedRaw
        .split('\n')
        .filter(Boolean)
        .map(parseStatusLine)
        .filter(Boolean) as { status: FileDiffSummary['status']; path: string }[];

      const unstagedRaw =
        unstagedStatusResult.exitCode === 0 ? unstagedStatusResult.stdout.trim() : '';
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
    (error) => processError(String(error), 1, ''),
  );
}

/**
 * Get the diff content for a single file.
 */
export function getSingleFileDiff(
  cwd: string,
  filePath: string,
  staged: boolean,
): ResultAsync<string, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (staged) {
        const result = await gitRead(['diff', '--staged', '--', filePath], {
          cwd,
          reject: false,
        });
        return result.exitCode === 0 ? result.stdout : '';
      }
      // Check if file is untracked
      const lsResult = await gitRead(
        ['ls-files', '--others', '--exclude-standard', '--', filePath],
        { cwd, reject: false },
      );
      if (lsResult.exitCode === 0 && lsResult.stdout.trim()) {
        // Untracked file — use diff --no-index
        const result = await gitRead(['diff', '--no-index', '/dev/null', filePath], {
          cwd,
          reject: false,
        });
        // --no-index exits with 1 when there are differences (expected)
        return result.stdout;
      }
      // Tracked, unstaged
      const result = await gitRead(['diff', '--', filePath], { cwd, reject: false });
      return result.exitCode === 0 ? result.stdout : '';
    })(),
    (error) => processError(String(error), 1, ''),
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

// ─── Result cache for expensive git queries ────────────────
const STATUS_CACHE_TTL = 2_000; // 2 seconds

const statusCache = new Map<string, { data: GitStatusSummary; ts: number }>();

function statusCacheKey(cwd: string, baseBranch?: string, projectCwd?: string): string {
  return `${cwd}|${baseBranch ?? ''}|${projectCwd ?? ''}`;
}

/** Invalidate status cache for a specific worktree path, or all entries. */
export function invalidateStatusCache(cwd?: string): void {
  if (cwd) {
    for (const key of statusCache.keys()) {
      if (key.startsWith(cwd + '|')) statusCache.delete(key);
    }
  } else {
    statusCache.clear();
  }
}

const MAX_UNTRACKED_TO_COUNT = 200;
const MAX_UNTRACKED_FILE_SIZE = 512 * 1024; // 512 KB

/** Unquote a path from git's porcelain output (C-style escaping inside double quotes). */
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  return inner.replace(/\\([tnr"\\])|\\([0-7]{3})/g, (_, esc, oct) => {
    if (oct) return String.fromCharCode(parseInt(oct, 8));
    switch (esc) {
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        return esc;
    }
  });
}

/**
 * Get a summary of the git status for a worktree.
 */
export function getStatusSummary(
  worktreeCwd: string,
  baseBranch?: string,
  projectCwd?: string,
): ResultAsync<GitStatusSummary, DomainError> {
  // Check cache first
  const cacheKey = statusCacheKey(worktreeCwd, baseBranch, projectCwd);
  const cached = statusCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < STATUS_CACHE_TTL) {
    return ResultAsync.fromSafePromise(Promise.resolve(cached.data));
  }

  // Try native module first
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(
      native
        .getStatusSummary(worktreeCwd, baseBranch ?? null, projectCwd ?? null)
        .then((result) => {
          statusCache.set(cacheKey, { data: result, ts: Date.now() });
          return result;
        }),
      (error) => processError(String(error), 1, ''),
    );
  }

  // Fallback: CLI-based implementation
  return ResultAsync.fromPromise(
    (async () => {
      // Phase 1: two git commands cover what previously took 4
      //   - `status --porcelain -b` → dirty file count + branch name
      //   - `diff HEAD --numstat`   → staged + unstaged line stats combined
      const [statusResult, diffResult] = await Promise.all([
        gitRead(['status', '--porcelain', '-b'], { cwd: worktreeCwd, reject: false }),
        gitRead(['diff', 'HEAD', '--numstat'], { cwd: worktreeCwd, reject: false }),
      ]);

      // Parse branch from the first line: "## branch" or "## branch...upstream [ahead N]"
      let branch: string | null = null;
      let dirtyFileCount = 0;
      const untrackedPaths: string[] = [];
      if (statusResult.exitCode === 0 && statusResult.stdout.trim()) {
        const lines = statusResult.stdout.trim().split('\n');
        const headerLine = lines[0]; // e.g. "## main...origin/main [ahead 2]"
        if (headerLine.startsWith('## ')) {
          const ref = headerLine.slice(3).split('...')[0].trim();
          if (ref && ref !== 'HEAD (no branch)') {
            branch = ref;
          }
        }
        // All lines after the header are dirty files
        const fileLines = lines.slice(1).filter(Boolean);
        dirtyFileCount = fileLines.length;
        for (const line of fileLines) {
          if (line.startsWith('?? ')) {
            untrackedPaths.push(unquoteGitPath(line.slice(3)));
          }
        }
      }

      // Parse combined line stats
      let linesAdded = 0;
      let linesDeleted = 0;
      if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
        for (const line of diffResult.stdout.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 2) {
            const added = parseInt(parts[0], 10);
            const deleted = parseInt(parts[1], 10);
            if (!isNaN(added)) linesAdded += added;
            if (!isNaN(deleted)) linesDeleted += deleted;
          }
        }
      }

      // Count lines in untracked files (not covered by git diff HEAD --numstat)
      if (untrackedPaths.length > 0) {
        const filesToCount = untrackedPaths.slice(0, MAX_UNTRACKED_TO_COUNT);
        const counts = await Promise.all(
          filesToCount.map(async (relPath) => {
            try {
              const file = Bun.file(join(worktreeCwd, relPath));
              const size = file.size;
              if (size === 0 || size > MAX_UNTRACKED_FILE_SIZE) return 0;
              const buffer = new Uint8Array(await file.arrayBuffer());
              // Binary detection: null bytes in first 8KB
              const checkLen = Math.min(buffer.length, 8192);
              for (let i = 0; i < checkLen; i++) {
                if (buffer[i] === 0) return 0;
              }
              // Count newlines
              let n = 0;
              for (let i = 0; i < buffer.length; i++) {
                if (buffer[i] === 0x0a) n++;
              }
              if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) n++;
              return n;
            } catch {
              return 0;
            }
          }),
        );
        for (const c of counts) linesAdded += c;
      }

      if (!branch) {
        const result: GitStatusSummary = {
          dirtyFileCount,
          unpushedCommitCount: 0,
          hasRemoteBranch: false,
          isMergedIntoBase: false,
          linesAdded,
          linesDeleted,
        };
        statusCache.set(cacheKey, { data: result, ts: Date.now() });
        return result;
      }

      // Phase 2: launch ALL conditional commands in parallel (consolidated from 2 phases)
      const [remoteResult, mergedResult, baseCountResult, mergeBaseResult, branchTipResult] =
        await Promise.all([
          gitRead(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
            cwd: worktreeCwd,
            reject: false,
          }),
          baseBranch && projectCwd
            ? gitRead(['branch', '--merged', baseBranch, '--format=%(refname:short)'], {
                cwd: projectCwd,
                reject: false,
              })
            : Promise.resolve(null),
          // Speculatively count against baseBranch — used when no remote exists
          baseBranch
            ? gitRead(['rev-list', '--count', `${baseBranch}..HEAD`], {
                cwd: worktreeCwd,
                reject: false,
              })
            : Promise.resolve(null),
          baseBranch && projectCwd
            ? gitRead(['merge-base', baseBranch, branch], { cwd: projectCwd, reject: false })
            : Promise.resolve(null),
          projectCwd
            ? gitRead(['rev-parse', branch], { cwd: projectCwd, reject: false })
            : Promise.resolve(null),
        ]);

      const remoteBranch = remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : null;
      const hasRemoteBranch = remoteBranch !== null;

      // If remote exists, we need count against it (one extra command).
      // Otherwise, use the speculative baseBranch count from above.
      let unpushedCommitCount = 0;
      if (hasRemoteBranch) {
        const remoteCount = await gitRead(['rev-list', '--count', `${remoteBranch}..HEAD`], {
          cwd: worktreeCwd,
          reject: false,
        });
        unpushedCommitCount =
          remoteCount.exitCode === 0 ? parseInt(remoteCount.stdout.trim(), 10) || 0 : 0;
      } else if (baseCountResult && baseCountResult.exitCode === 0) {
        unpushedCommitCount = parseInt(baseCountResult.stdout.trim(), 10) || 0;
      }

      const needsMergeCheck =
        mergedResult &&
        mergedResult.exitCode === 0 &&
        mergedResult.stdout.trim() &&
        mergedResult.stdout
          .trim()
          .split('\n')
          .map((b) => b.trim())
          .includes(branch);

      let isMergedIntoBase = false;
      if (needsMergeCheck && mergeBaseResult && branchTipResult) {
        if (mergeBaseResult.exitCode === 0 && branchTipResult.exitCode === 0) {
          isMergedIntoBase = mergeBaseResult.stdout.trim() !== branchTipResult.stdout.trim();
        } else {
          isMergedIntoBase = true;
        }
      }

      const result: GitStatusSummary = {
        dirtyFileCount,
        unpushedCommitCount,
        hasRemoteBranch,
        isMergedIntoBase,
        linesAdded,
        linesDeleted,
      };
      statusCache.set(cacheKey, { data: result, ts: Date.now() });
      return result;
    })(),
    (error) => processError(String(error), 1, ''),
  );
}

/**
 * Derive a single sync state from a git status summary.
 */
export function deriveGitSyncState(summary: GitStatusSummary): GitSyncState {
  if (summary.dirtyFileCount > 0) return 'dirty';
  if (summary.unpushedCommitCount > 0) return 'unpushed';
  if (summary.isMergedIntoBase) return 'merged';
  if (summary.hasRemoteBranch) return 'pushed';
  return 'clean';
}

// ─── Commit Log ─────────────────────────────────────────

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  relativeDate: string;
  message: string;
}

/**
 * Get recent commit log entries.
 * When baseBranch is provided, only shows commits in HEAD that are not in baseBranch
 * (i.e. `git log baseBranch..HEAD`), which is useful for worktree branches.
 */
export function getLog(
  cwd: string,
  limit = 20,
  baseBranch?: string | null,
): ResultAsync<GitLogEntry[], DomainError> {
  const native = getNativeGit();
  if (native && !baseBranch) {
    return ResultAsync.fromPromise(native.getLog(cwd, limit), (error) =>
      processError(String(error), 1, ''),
    );
  }
  const SEP = '@@SEP@@';
  const format = `%H${SEP}%h${SEP}%an${SEP}%ar${SEP}%s`;
  const args = ['log', `--format=${format}`, `-n`, String(limit)];
  if (baseBranch) {
    args.push(`${baseBranch}..HEAD`);
  }
  return git(args, cwd).map((output) => {
    if (!output.trim()) return [];
    return output
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, shortHash, author, relativeDate, message] = line.split(SEP);
        return { hash, shortHash, author, relativeDate, message };
      });
  });
}

// ─── Pull ────────────────────────────────────────────────

/**
 * Pull from remote (fast-forward only).
 */
export function pull(cwd: string, identity?: GitIdentityOptions): ResultAsync<string, DomainError> {
  const env = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
  return git(['pull', '--ff-only'], cwd, env);
}

// ─── Stash ───────────────────────────────────────────────

export interface StashEntry {
  index: string;
  message: string;
  relativeDate: string;
}

/**
 * Stash current changes.
 */
export function stash(cwd: string): ResultAsync<string, DomainError> {
  return git(['stash', 'push', '-m', 'funny: stashed changes'], cwd);
}

/**
 * Pop the most recent stash.
 */
export function stashPop(cwd: string): ResultAsync<string, DomainError> {
  return git(['stash', 'pop'], cwd);
}

/**
 * List stash entries.
 */
export function stashList(cwd: string): ResultAsync<StashEntry[], DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitRead(['stash', 'list', '--format=%gd|%gs|%ar'], {
        cwd,
        reject: false,
      });
      if (result.exitCode !== 0 || !result.stdout.trim()) return [];
      return result.stdout
        .trim()
        .split('\n')
        .map((line) => {
          const [index, message, relativeDate] = line.split('|');
          return { index: index || '', message: message || '', relativeDate: relativeDate || '' };
        });
    })(),
    (error) => internal(String(error)),
  );
}

// ─── Reset Soft ──────────────────────────────────────────

/**
 * Undo the last commit, keeping changes staged.
 */
export function resetSoft(cwd: string): ResultAsync<string, DomainError> {
  return git(['reset', '--soft', 'HEAD~1'], cwd);
}
