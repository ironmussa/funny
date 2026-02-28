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

import type { GitStatusSummary } from './git.js';

export interface NativeGitStatusSummary {
  dirtyFileCount: number;
  unpushedCommitCount: number;
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
  files: Array<{ path: string; status: string; staged: boolean }>;
  total: number;
  truncated: boolean;
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
  };
}

/**
 * Get the pooled native git module, or null if it's not available.
 * Result is cached after the first attempt.
 */
export function getNativeGit(): PooledNativeGitModule | null {
  if (_attempted) return _pooled;
  _attempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _native = require('@funny/native-git') as NativeGitModule;
    _pooled = createPooledModule(_native);
    console.log('[git] Native module loaded (Rust/gitoxide)');
  } catch {
    _native = null;
    _pooled = null;
    console.log('[git] Native module not available, using CLI fallback');
  }
  return _pooled;
}
