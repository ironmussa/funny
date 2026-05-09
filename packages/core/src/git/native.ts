/**
 * Native git module loader with graceful fallback.
 *
 * Attempts to load @funny/native-git (Rust/NAPI-RS + gitoxide) on first call.
 * Falls back to null when the native module is unavailable (unsupported platform,
 * missing binary, build failure), letting callers use the CLI-based implementation.
 *
 * Heavy I/O operations (status, diff) are throttled through a concurrency pool
 * to avoid saturating the disk when many worktrees are polled simultaneously.
 */

import pLimit from 'p-limit';

export interface NativeGitStatusSummary {
  dirtyFileCount: number;
  unpushedCommitCount: number;
  unpulledCommitCount: number;
  hasRemoteBranch: boolean;
  isMergedIntoBase: boolean;
  linesAdded: number;
  linesDeleted: number;
}

export interface NativeGitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  relativeDate: string;
  message: string;
}

export interface NativeDiffSummaryResult {
  files: Array<{
    path: string;
    status: string;
    staged: boolean;
    additions: number;
    deletions: number;
  }>;
  total: number;
  truncated: boolean;
}

export interface NativeCommitFileEntry {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface NativeBranchDetailedInfo {
  name: string;
  isLocal: boolean;
  isRemote: boolean;
}

export interface NativeListFilesOptions {
  includeIgnored?: boolean;
}

export interface NativeStashEntry {
  index: string;
  message: string;
  relativeDate: string;
}

export interface NativeStashFileEntry {
  path: string;
  additions: number;
  deletions: number;
}

export interface NativeGitModule {
  ping(): string;
  getStatusSummary(
    worktreeCwd: string,
    baseBranch?: string | null,
    projectCwd?: string | null,
  ): Promise<NativeGitStatusSummary>;
  getDiffSummary(
    cwd: string,
    excludePatterns?: string[] | null,
    maxFiles?: number | null,
  ): Promise<NativeDiffSummaryResult>;
  getCurrentBranch(cwd: string): Promise<string | null>;
  listBranches(cwd: string): Promise<string[]>;
  getDefaultBranch(cwd: string): Promise<string | null>;
  getLog(cwd: string, limit?: number | null): Promise<NativeGitLogEntry[]>;
  getCommitBody(cwd: string, hash: string): Promise<string>;
  getRemoteUrl(cwd: string): Promise<string | null>;
  listBranchesDetailed(cwd: string): Promise<NativeBranchDetailedInfo[]>;
  getSingleFileDiff(cwd: string, filePath: string, staged: boolean): Promise<string>;
  getFullContextFileDiff(cwd: string, filePath: string, staged: boolean): Promise<string>;
  getCommitFileDiff(cwd: string, hash: string, filePath: string): Promise<string>;
  getCommitFiles(cwd: string, hash: string): Promise<NativeCommitFileEntry[]>;
  getUnpushedHashes(cwd: string): Promise<string[]>;
  resetSoft(cwd: string): Promise<void>;
  listFiles(cwd: string, options?: NativeListFilesOptions | null): Promise<string[]>;
  getStashList(cwd: string): Promise<NativeStashEntry[]>;
  getStashShow(cwd: string, stashRef: string): Promise<NativeStashFileEntry[]>;
  getStashFileDiff(cwd: string, stashRef: string, filePath: string): Promise<string>;
  checkIgnore(cwd: string, paths: string[]): Promise<string[]>;
  listUnmergedFiles(cwd: string): Promise<string[]>;
}

// Heavy I/O ops (status scan, diff scan) — limit concurrent disk reads
const heavyPool = pLimit(8);
// Lightweight ops (branch lookup, log) — higher concurrency since they're fast
const lightPool = pLimit(20);

let _native: NativeGitModule | null = null;
let _pooled: PooledNativeGitModule | null = null;
let _attempted = false;

/** Pooled wrapper that throttles native calls to avoid I/O saturation. */
export interface PooledNativeGitModule {
  ping(): string;
  getStatusSummary(
    worktreeCwd: string,
    baseBranch?: string | null,
    projectCwd?: string | null,
  ): Promise<NativeGitStatusSummary>;
  getDiffSummary(
    cwd: string,
    excludePatterns?: string[] | null,
    maxFiles?: number | null,
  ): Promise<NativeDiffSummaryResult>;
  getCurrentBranch(cwd: string): Promise<string | null>;
  listBranches(cwd: string): Promise<string[]>;
  getDefaultBranch(cwd: string): Promise<string | null>;
  getLog(cwd: string, limit?: number | null): Promise<NativeGitLogEntry[]>;
  getCommitBody(cwd: string, hash: string): Promise<string>;
  getRemoteUrl(cwd: string): Promise<string | null>;
  listBranchesDetailed(cwd: string): Promise<NativeBranchDetailedInfo[]>;
  getSingleFileDiff(cwd: string, filePath: string, staged: boolean): Promise<string>;
  getFullContextFileDiff(cwd: string, filePath: string, staged: boolean): Promise<string>;
  getCommitFileDiff(cwd: string, hash: string, filePath: string): Promise<string>;
  getCommitFiles(cwd: string, hash: string): Promise<NativeCommitFileEntry[]>;
  getUnpushedHashes(cwd: string): Promise<string[]>;
  resetSoft(cwd: string): Promise<void>;
  listFiles(cwd: string, options?: NativeListFilesOptions | null): Promise<string[]>;
  getStashList(cwd: string): Promise<NativeStashEntry[]>;
  getStashShow(cwd: string, stashRef: string): Promise<NativeStashFileEntry[]>;
  getStashFileDiff(cwd: string, stashRef: string, filePath: string): Promise<string>;
  checkIgnore(cwd: string, paths: string[]): Promise<string[]>;
  listUnmergedFiles(cwd: string): Promise<string[]>;
}

function createPooledModule(mod: NativeGitModule): PooledNativeGitModule {
  return {
    ping: () => mod.ping(),
    getStatusSummary: (...args) => heavyPool(() => mod.getStatusSummary(...args)),
    getDiffSummary: (...args) => heavyPool(() => mod.getDiffSummary(...args)),
    getCurrentBranch: (...args) => lightPool(() => mod.getCurrentBranch(...args)),
    listBranches: (...args) => lightPool(() => mod.listBranches(...args)),
    getDefaultBranch: (...args) => lightPool(() => mod.getDefaultBranch(...args)),
    getLog: (...args) => lightPool(() => mod.getLog(...args)),
    getCommitBody: (...args) => lightPool(() => mod.getCommitBody(...args)),
    getRemoteUrl: (...args) => lightPool(() => mod.getRemoteUrl(...args)),
    listBranchesDetailed: (...args) => lightPool(() => mod.listBranchesDetailed(...args)),
    getSingleFileDiff: (...args) => heavyPool(() => mod.getSingleFileDiff(...args)),
    getFullContextFileDiff: (...args) => heavyPool(() => mod.getFullContextFileDiff(...args)),
    getCommitFileDiff: (...args) => heavyPool(() => mod.getCommitFileDiff(...args)),
    getCommitFiles: (...args) => heavyPool(() => mod.getCommitFiles(...args)),
    getUnpushedHashes: (...args) => lightPool(() => mod.getUnpushedHashes(...args)),
    resetSoft: (...args) => heavyPool(() => mod.resetSoft(...args)),
    listFiles: (...args) => heavyPool(() => mod.listFiles(...args)),
    getStashList: (...args) => lightPool(() => mod.getStashList(...args)),
    getStashShow: (...args) => lightPool(() => mod.getStashShow(...args)),
    getStashFileDiff: (...args) => heavyPool(() => mod.getStashFileDiff(...args)),
    checkIgnore: (...args) => lightPool(() => mod.checkIgnore(...args)),
    listUnmergedFiles: (...args) => lightPool(() => mod.listUnmergedFiles(...args)),
  };
}

/**
 * Get the pooled native git module, or null if it's not available.
 * Result is cached after the first attempt.
 */
export function getNativeGit(): PooledNativeGitModule | null {
  if (process.env.FUNNY_DISABLE_NATIVE_GIT === '1') return null;
  if (_attempted) return _pooled;
  _attempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _native = require('@funny/native-git') as NativeGitModule;
    _pooled = createPooledModule(_native);
    // native git module loaded successfully
  } catch {
    _native = null;
    _pooled = null;
    // native module not available, CLI fallback will be used
  }
  return _pooled;
}
