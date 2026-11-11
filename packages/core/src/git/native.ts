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

import { createConcurrencyLimiter } from '@funny/shared/async';

export interface NativeGitStatusSummary {
  dirtyFileCount: number;
  unpushedCommitCount: number;
  unpulledCommitCount: number;
  hasRemoteBranch: boolean;
  isMergedIntoBase: boolean;
  linesAdded: number;
  linesDeleted: number;
}

export interface NativeWorktreeEntry {
  path: string;
  commit: string;
  /** Short branch name; absent when HEAD is detached. */
  branch?: string;
}

export interface NativeGitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  authoredAt: number;
  message: string;
  body?: string;
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
  createdAt: number;
}

export interface NativeStashFileEntry {
  path: string;
  additions: number;
  deletions: number;
}

export interface NativeBlameHunk {
  startLine: number;
  lineCount: number;
  commitHash: string;
  shortHash: string;
  author: string;
  authoredAt: number;
  summary: string;
}

export interface NativeBlameResult {
  hunks: NativeBlameHunk[];
  blamedLineCount: number;
}

export interface NativeBranchSummaryResult {
  linesAdded: number;
  linesDeleted: number;
  unpushedCommitCount: number;
  unpulledCommitCount: number;
  hasRemoteBranch: boolean;
  isMergedIntoBase: boolean;
}

interface NativeGitModule {
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
  getRefFingerprint(cwd: string, extraRefs: string[]): Promise<string>;
  listWorktrees(cwd: string): Promise<NativeWorktreeEntry[]>;
  getBranchSummary(
    cwd: string,
    baseBranch: string,
    branch: string,
  ): Promise<NativeBranchSummaryResult>;
  blameFile(filePath: string): Promise<NativeBlameResult>;
}

// Heavy I/O ops (status scan, diff scan) — limit concurrent disk reads
const heavyPool = createConcurrencyLimiter(8);
// Lightweight ops (branch lookup, log) — higher concurrency since they're fast
const lightPool = createConcurrencyLimiter(20);

let nativeModule: NativeGitModule | null = null;
let pooledModule: PooledNativeGitModule | null = null;
let loadAttempted = false;
let nativeLoadError: string | null = null;

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
  getRefFingerprint(cwd: string, extraRefs: string[]): Promise<string>;
  listWorktrees(cwd: string): Promise<NativeWorktreeEntry[]>;
  getBranchSummary(
    cwd: string,
    baseBranch: string,
    branch: string,
  ): Promise<NativeBranchSummaryResult>;
  blameFile(filePath: string): Promise<NativeBlameResult>;
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
    getRefFingerprint: (...args) => lightPool(() => mod.getRefFingerprint(...args)),
    listWorktrees: (...args) => lightPool(() => mod.listWorktrees(...args)),
    getBranchSummary: (...args) => heavyPool(() => mod.getBranchSummary(...args)),
    blameFile: (...args) => lightPool(() => mod.blameFile(...args)),
  };
}

/**
 * Get the pooled native git module, or null if it's not available.
 * Result is cached after the first attempt.
 */
export function getNativeGit(): PooledNativeGitModule | null {
  if (process.env.FUNNY_DISABLE_NATIVE_GIT === '1') return null;
  if (loadAttempted) return pooledModule;
  loadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeModule = require('@funny/native-git') as NativeGitModule;
    pooledModule = createPooledModule(nativeModule);
    // native git module loaded successfully
  } catch (error) {
    nativeModule = null;
    pooledModule = null;
    // native module not available, CLI fallback will be used
    nativeLoadError = error instanceof Error ? error.message : String(error);
  }
  return pooledModule;
}

export type NativeGitStatus =
  | { state: 'loaded' }
  | { state: 'disabled' }
  | { state: 'unavailable'; error: string };

/**
 * Whether the gitoxide module is in use. Attempts the load if it has not
 * happened yet, so callers can report the outcome at startup instead of the
 * CLI fallback kicking in silently.
 */
export function getNativeGitStatus(): NativeGitStatus {
  if (process.env.FUNNY_DISABLE_NATIVE_GIT === '1') return { state: 'disabled' };
  if (getNativeGit()) return { state: 'loaded' };
  return { state: 'unavailable', error: nativeLoadError ?? 'unknown error' };
}
