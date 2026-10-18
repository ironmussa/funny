/**
 * Git status summary with caching, binary detection, and sync state derivation.
 */

import type { GitSyncState } from '@funny/shared';
import { badRequest, processError, type DomainError } from '@funny/shared/errors';
import { errAsync, ResultAsync } from 'neverthrow';

import { countUntrackedTextFileLines } from './diff.js';
import { getNativeGit } from './native.js';
import { gitRead } from './process.js';
import { isSafeGitRefArg } from './ref-guard.js';

// ─── Types ──────────────────────────────────────────────

export interface GitStatusSummary {
  dirtyFileCount: number;
  unpushedCommitCount: number;
  unpulledCommitCount: number;
  hasRemoteBranch: boolean;
  isMergedIntoBase: boolean;
  linesAdded: number;
  linesDeleted: number;
}

// ─── Result cache for expensive git queries ─────────────

const STATUS_CACHE_TTL = 1_000; // 1 second
const STATUS_CACHE_MAX_ENTRIES = 1_000;
const UNTRACKED_LINE_COUNT_CONCURRENCY = 4;

const statusCache = new Map<string, { data: GitStatusSummary; ts: number }>();
const statusInFlight = new Map<string, Promise<GitStatusSummary>>();

function statusCacheKey(cwd: string, baseBranch?: string, projectCwd?: string): string {
  return `${cwd}|${baseBranch ?? ''}|${projectCwd ?? ''}`;
}

/** Evict oldest entries when the cache exceeds the max size. Map iteration order is insertion order. */
function evictStatusCacheIfNeeded(): void {
  if (statusCache.size <= STATUS_CACHE_MAX_ENTRIES) return;
  const toRemove = statusCache.size - STATUS_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const key of statusCache.keys()) {
    if (removed >= toRemove) break;
    statusCache.delete(key);
    removed++;
  }
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

async function countUntrackedLines(cwd: string, paths: string[]): Promise<number> {
  let cursor = 0;
  let total = 0;
  const worker = async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++];
      if (!path || path.endsWith('/')) continue;
      const lines = await countUntrackedTextFileLines(cwd, path);
      if (lines !== null) total += lines;
    }
  };
  const workerCount = Math.min(UNTRACKED_LINE_COUNT_CONCURRENCY, paths.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return total;
}

// ─── CLI fallback helpers ───────────────────────────────

type GitResult = Awaited<ReturnType<typeof gitRead>>;

/** Trimmed stdout of a successful command, or '' (failed / missing / empty). */
function okStdout(result: GitResult | null): string {
  return result && result.exitCode === 0 ? result.stdout.trim() : '';
}

/** Parse a `rev-list --count` result; 0 on failure or non-numeric output. */
function parseCount(result: GitResult | null): number {
  return result && result.exitCode === 0 ? parseInt(result.stdout.trim(), 10) || 0 : 0;
}

/** Sum `git diff --numstat` output; binary entries ("-") are skipped. */
function sumNumstat(stdout: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  if (!stdout) return { added, deleted };
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const a = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    if (!isNaN(a)) added += a;
    if (!isNaN(d)) deleted += d;
  }
  return { added, deleted };
}

/** Parse the branch from "## branch" or "## branch...upstream [ahead N]". */
function parseBranchHeader(headerLine: string): string | null {
  if (!headerLine.startsWith('## ')) return null;
  const ref = headerLine.slice(3).split('...')[0].trim();
  // Handle empty repo headers like "## No commits yet on master"
  const noCommitsMatch = ref.match(/^No commits yet on (.+)$/);
  if (noCommitsMatch) return noCommitsMatch[1];
  return ref && ref !== 'HEAD (no branch)' ? ref : null;
}

/**
 * Parse `status --porcelain -b` into the branch name and dirty file count.
 * The untracked count prefers ls-files (expands directories) over porcelain
 * (collapses them).
 */
function parsePorcelainStatus(
  statusStdout: string,
  untrackedFiles: string[],
): { branch: string | null; dirtyFileCount: number } {
  if (!statusStdout) return { branch: null, dirtyFileCount: 0 };
  const lines = statusStdout.split('\n');
  const branch = parseBranchHeader(lines[0]);
  // Count tracked dirty files (exclude untracked '??' entries — counted separately)
  const untrackedPaths: string[] = [];
  let trackedDirtyCount = 0;
  for (const line of lines.slice(1).filter(Boolean)) {
    if (line.startsWith('?? ')) untrackedPaths.push(unquoteGitPath(line.slice(3)));
    else trackedDirtyCount++;
  }
  const untrackedFileCount =
    untrackedFiles.length > 0 ? untrackedFiles.length : untrackedPaths.length;
  return { branch, dirtyFileCount: trackedDirtyCount + untrackedFileCount };
}

interface WorkingTreeStats {
  dirtyFileCount: number;
  linesAdded: number;
  linesDeleted: number;
}

/**
 * Phase 1: three git commands
 *   - `status --porcelain -b`              → branch name + tracked dirty files
 *   - `diff HEAD --numstat`                 → staged + unstaged line stats combined
 *   - `ls-files --others --exclude-standard` → accurate untracked file count
 *     (porcelain collapses untracked dirs into one entry; ls-files expands them)
 */
async function readWorkingTree(
  cwd: string,
): Promise<{ branch: string | null; stats: WorkingTreeStats }> {
  const [statusResult, diffResult, untrackedResult] = await Promise.all([
    gitRead(['status', '--porcelain', '-b'], { cwd, reject: false }),
    gitRead(['diff', 'HEAD', '--numstat'], { cwd, reject: false }),
    gitRead(['ls-files', '--others', '--exclude-standard'], { cwd, reject: false }),
  ]);

  const untrackedStdout = okStdout(untrackedResult);
  const untrackedFiles = untrackedStdout ? untrackedStdout.split('\n') : [];
  const { branch, dirtyFileCount } = parsePorcelainStatus(okStdout(statusResult), untrackedFiles);
  const diff = sumNumstat(okStdout(diffResult));

  // Untracked files don't appear in `git diff --numstat`. Count their lines
  // directly with bounded file-read concurrency: spawning one
  // `git diff --no-index` per file can saturate a machine when a generated directory
  // (vendor, node_modules, dist, etc.) is accidentally left unignored.
  const untrackedLines = await countUntrackedLines(cwd, untrackedFiles);

  return {
    branch,
    stats: {
      dirtyFileCount,
      linesAdded: diff.added + untrackedLines,
      linesDeleted: diff.deleted,
    },
  };
}

/** Run a read-only git command when `cond` holds; resolves to null otherwise. */
function gitReadIf(
  cond: unknown,
  args: string[],
  cwd: string | undefined,
): Promise<GitResult | null> {
  return cond ? gitRead(args, { cwd, reject: false }) : Promise.resolve(null);
}

/**
 * Unpushed count uses `HEAD --not --remotes` so the Changes badge matches the
 * History tab's `getUnpushedHashes` (commits not present on any remote ref).
 * The legacy `<upstream>..HEAD` form disagreed when the upstream pointer was
 * stale or pointed at a different branch.
 * When no remote branch exists, fall back to the speculative baseBranch count.
 */
async function readCommitCounts(
  cwd: string,
  remoteBranch: string | null,
  baseCountResult: GitResult | null,
): Promise<{ unpushedCommitCount: number; unpulledCommitCount: number }> {
  if (remoteBranch === null) {
    return { unpushedCommitCount: parseCount(baseCountResult), unpulledCommitCount: 0 };
  }
  const [unpushedResult, behindResult] = await Promise.all([
    gitRead(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd, reject: false }),
    gitRead(['rev-list', '--count', `HEAD..${remoteBranch}`], { cwd, reject: false }),
  ]);
  return {
    unpushedCommitCount: parseCount(unpushedResult),
    unpulledCommitCount: parseCount(behindResult),
  };
}

function detectMergedIntoBase(
  branch: string,
  mergedResult: GitResult | null,
  mergeBaseResult: GitResult | null,
  branchTipResult: GitResult | null,
): boolean {
  const merged = okStdout(mergedResult);
  const listedAsMerged =
    merged !== '' &&
    merged
      .split('\n')
      .map((b) => b.trim())
      .includes(branch);
  if (!listedAsMerged || !mergeBaseResult || !branchTipResult) return false;
  if (mergeBaseResult.exitCode !== 0 || branchTipResult.exitCode !== 0) return true;
  return mergeBaseResult.stdout.trim() !== branchTipResult.stdout.trim();
}

/** Phase 2: launch ALL conditional commands in parallel (consolidated from 2 phases). */
async function readBranchState(
  worktreeCwd: string,
  branch: string,
  stats: WorkingTreeStats,
  baseBranch?: string,
  projectCwd?: string,
): Promise<GitStatusSummary> {
  const withProject = baseBranch && projectCwd;
  const [
    remoteResult,
    mergedResult,
    baseCountResult,
    mergeBaseResult,
    branchTipResult,
    baseDiffResult,
  ] = await Promise.all([
    gitRead(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
      cwd: worktreeCwd,
      reject: false,
    }),
    gitReadIf(
      withProject,
      ['branch', '--merged', `${baseBranch}`, '--format=%(refname:short)'],
      projectCwd,
    ),
    // Speculatively count against baseBranch — used when no remote exists
    gitReadIf(baseBranch, ['rev-list', '--count', `${baseBranch}..HEAD`], worktreeCwd),
    gitReadIf(withProject, ['merge-base', `${baseBranch}`, branch], projectCwd),
    gitReadIf(projectCwd, ['rev-parse', branch], projectCwd),
    // Line diff against baseBranch — includes committed changes so diff stats
    // persist after the agent commits (git diff HEAD only shows uncommitted).
    gitReadIf(baseBranch, ['diff', `${baseBranch}...HEAD`, '--numstat'], worktreeCwd),
  ]);

  const remoteBranch = remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : null;
  const counts = await readCommitCounts(worktreeCwd, remoteBranch, baseCountResult);

  // Include committed line changes against baseBranch as a FALLBACK so diff
  // stats don't drop to zero when the agent commits its changes.
  // Only use branch-level stats when the working tree has no uncommitted changes;
  // otherwise the working-tree stats are authoritative (they match the per-file
  // diff stats shown in the ReviewPane).
  const useBaseDiff = stats.linesAdded === 0 && stats.linesDeleted === 0;
  const base = useBaseDiff ? sumNumstat(okStdout(baseDiffResult)) : null;

  return {
    dirtyFileCount: stats.dirtyFileCount,
    unpushedCommitCount: counts.unpushedCommitCount,
    unpulledCommitCount: counts.unpulledCommitCount,
    hasRemoteBranch: remoteBranch !== null,
    isMergedIntoBase: detectMergedIntoBase(branch, mergedResult, mergeBaseResult, branchTipResult),
    linesAdded: base ? base.added : stats.linesAdded,
    linesDeleted: base ? base.deleted : stats.linesDeleted,
  };
}

/** CLI fallback for `getStatusSummary`. */
async function cliStatusSummary(
  worktreeCwd: string,
  baseBranch?: string,
  projectCwd?: string,
): Promise<GitStatusSummary> {
  const { branch, stats } = await readWorkingTree(worktreeCwd);
  if (branch) return readBranchState(worktreeCwd, branch, stats, baseBranch, projectCwd);
  return {
    dirtyFileCount: stats.dirtyFileCount,
    unpushedCommitCount: 0,
    unpulledCommitCount: 0,
    hasRemoteBranch: false,
    isMergedIntoBase: false,
    linesAdded: stats.linesAdded,
    linesDeleted: stats.linesDeleted,
  };
}

/** Native fast path; null when unavailable or failed (e.g. empty repo with no HEAD). */
async function nativeStatusSummary(
  native: ReturnType<typeof getNativeGit>,
  worktreeCwd: string,
  baseBranch?: string,
  projectCwd?: string,
): Promise<GitStatusSummary | null> {
  if (!native) return null;
  try {
    return await native.getStatusSummary(worktreeCwd, baseBranch ?? null, projectCwd ?? null);
  } catch {
    // Native module failed — fall through to CLI
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────

/**
 * Get a summary of the git status for a worktree.
 */
export function getStatusSummary(
  worktreeCwd: string,
  rawBaseBranch?: string,
  projectCwd?: string,
): ResultAsync<GitStatusSummary, DomainError> {
  // Security (M7): baseBranch is persisted from user input and passed
  // positionally to git below; a value like `--output=x` would be parsed as an
  // option. Treat an unsafe value as "no base branch" instead of failing the
  // whole status call.
  const baseBranch = isSafeGitRefArg(rawBaseBranch) ? rawBaseBranch : undefined;
  // Check cache first
  const cacheKey = statusCacheKey(worktreeCwd, baseBranch, projectCwd);
  const cached = statusCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < STATUS_CACHE_TTL) {
    return ResultAsync.fromSafePromise(Promise.resolve(cached.data));
  }

  const existing = statusInFlight.get(cacheKey);
  if (existing) {
    return ResultAsync.fromPromise(existing, (error) => processError(String(error), 1, ''));
  }

  // Try native module first, fall back to CLI
  const native = getNativeGit();

  const operation = (async () => {
    const result =
      (await nativeStatusSummary(native, worktreeCwd, baseBranch, projectCwd)) ??
      (await cliStatusSummary(worktreeCwd, baseBranch, projectCwd));
    statusCache.set(cacheKey, { data: result, ts: Date.now() });
    evictStatusCacheIfNeeded();
    return result;
  })();
  statusInFlight.set(cacheKey, operation);
  void operation.then(
    () => {
      if (statusInFlight.get(cacheKey) === operation) statusInFlight.delete(cacheKey);
    },
    () => {
      if (statusInFlight.get(cacheKey) === operation) statusInFlight.delete(cacheKey);
    },
  );
  return ResultAsync.fromPromise(operation, (error) => processError(String(error), 1, ''));
}

/**
 * Summary of committed-only changes between baseBranch and branch, computed
 * without touching the working tree. Used for local-mode threads whose branch
 * is NOT currently checked out in the project's working directory, so they
 * can display their own diff stats instead of inheriting whichever branch
 * happens to be checked out right now.
 */
export function getCommittedBranchSummary(
  repoCwd: string,
  baseBranch: string,
  branch: string,
): ResultAsync<GitStatusSummary, DomainError> {
  if (!isSafeGitRefArg(baseBranch) || !isSafeGitRefArg(branch)) {
    return errAsync(badRequest(`Invalid git branch: ${baseBranch}...${branch}`));
  }
  return ResultAsync.fromPromise(
    (async () => {
      // Native fast path: one in-process pass for the diff base...branch line
      // counts, the merge-base check, and the upstream-existence check; only
      // the rev-list commit counts shell out (gix's rev_walk miscounts when
      // merge commits are involved). CLI fallback below mirrors the original
      // 4-spawn (+2 conditional) shape.
      const native = getNativeGit();
      if (native) {
        try {
          const r = await native.getBranchSummary(repoCwd, baseBranch, branch);
          return {
            dirtyFileCount: 0,
            unpushedCommitCount: r.unpushedCommitCount,
            unpulledCommitCount: r.unpulledCommitCount,
            hasRemoteBranch: r.hasRemoteBranch,
            isMergedIntoBase: r.isMergedIntoBase,
            linesAdded: r.linesAdded,
            linesDeleted: r.linesDeleted,
          };
        } catch {
          // Native module failed — fall through to CLI
        }
      }

      const [diffResult, remoteResult, baseCountResult, mergedResult] = await Promise.all([
        gitRead(['diff', `${baseBranch}...${branch}`, '--numstat'], {
          cwd: repoCwd,
          reject: false,
        }),
        gitRead(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], {
          cwd: repoCwd,
          reject: false,
        }),
        gitRead(['rev-list', '--count', `${baseBranch}..${branch}`], {
          cwd: repoCwd,
          reject: false,
        }),
        gitRead(['branch', '--merged', baseBranch, '--format=%(refname:short)'], {
          cwd: repoCwd,
          reject: false,
        }),
      ]);

      let linesAdded = 0;
      let linesDeleted = 0;
      if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
        for (const line of diffResult.stdout.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 2) {
            const a = parseInt(parts[0], 10);
            const d = parseInt(parts[1], 10);
            if (!isNaN(a)) linesAdded += a;
            if (!isNaN(d)) linesDeleted += d;
          }
        }
      }

      const remoteBranch = remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : null;
      const hasRemoteBranch = !!remoteBranch;
      let unpushedCommitCount = 0;
      let unpulledCommitCount = 0;
      if (hasRemoteBranch && remoteBranch) {
        const [aheadResult, behindResult] = await Promise.all([
          // Match the History tab: commits on this branch not on any remote ref.
          gitRead(['rev-list', '--count', branch, '--not', '--remotes'], {
            cwd: repoCwd,
            reject: false,
          }),
          gitRead(['rev-list', '--count', `${branch}..${remoteBranch}`], {
            cwd: repoCwd,
            reject: false,
          }),
        ]);
        unpushedCommitCount =
          aheadResult.exitCode === 0 ? parseInt(aheadResult.stdout.trim(), 10) || 0 : 0;
        unpulledCommitCount =
          behindResult.exitCode === 0 ? parseInt(behindResult.stdout.trim(), 10) || 0 : 0;
      } else if (baseCountResult.exitCode === 0) {
        unpushedCommitCount = parseInt(baseCountResult.stdout.trim(), 10) || 0;
      }

      let isMergedIntoBase = false;
      if (mergedResult.exitCode === 0 && mergedResult.stdout) {
        isMergedIntoBase = mergedResult.stdout
          .split('\n')
          .map((b) => b.trim())
          .includes(branch);
      }

      return {
        dirtyFileCount: 0,
        unpushedCommitCount,
        unpulledCommitCount,
        hasRemoteBranch,
        isMergedIntoBase,
        linesAdded,
        linesDeleted,
      };
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
