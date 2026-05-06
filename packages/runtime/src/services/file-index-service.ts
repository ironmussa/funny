/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: infrastructure
 * @domain consumes: git:changed
 *
 * Per-project in-memory file list index. Built once via `git ls-files`,
 * kept fresh by:
 *   1. A recursive fs.watch on the project root (incremental add/remove)
 *   2. Listening to git:changed events (full rebuild on branch ops)
 *
 * Each index carries a monotonically increasing `version` so clients can do
 * delta sync (`?since=N` returns only changes when possible).
 */

import { watch, type FSWatcher } from 'fs';
import { stat } from 'fs/promises';
import { join, relative, sep } from 'path';

import { log } from '../lib/logger.js';
import {
  HEAVY_IGNORED_DIRS,
  invalidateGitFilesCache,
  resolveGitFiles,
} from '../utils/git-files.js';
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
import { threadEventBus } from './thread-event-bus.js';

const WATCH_DEBOUNCE_MS = 80;
const REBUILD_DEBOUNCE_MS = 250;
const STALE_TTL_MS = 5 * 60_000;

interface FileIndex {
  /** Sorted list of files (relative POSIX paths). */
  files: string[];
  /** Monotonic counter; increments on every full rebuild or batched change. */
  version: number;
  /** Wall-clock time of last build for staleness checks. */
  lastBuiltAt: number;
  /** Pending mutations between watcher batches. */
  pending: { added: Set<string>; removed: Set<string> };
  /** Recursive fs.watch handle, if available. */
  watcher: FSWatcher | null;
  watchDebounce: ReturnType<typeof setTimeout> | null;
  rebuildDebounce: ReturnType<typeof setTimeout> | null;
  /** True while a rebuild is in flight; coalesces concurrent calls. */
  rebuilding: Promise<void> | null;
}

const indexes = new Map<string, FileIndex>();

// ── Public API ───────────────────────────────────────────────

export interface FileIndexSnapshot {
  files: string[];
  version: number;
  /** True when the index was built fresh during this call. */
  fresh: boolean;
}

/**
 * Get the current file list for `projectPath`. If no index exists yet, builds
 * one synchronously (awaiting the first `git ls-files` call). Subsequent calls
 * return the cached snapshot in O(1). Stale entries (>5 min) are rebuilt in
 * the background but the cached result is returned immediately.
 */
export async function getFileIndex(projectPath: string): Promise<FileIndexSnapshot> {
  const existing = indexes.get(projectPath);

  if (!existing) {
    const idx = await buildIndex(projectPath);
    return { files: idx.files, version: idx.version, fresh: true };
  }

  // Background staleness refresh — return current snapshot immediately
  if (Date.now() - existing.lastBuiltAt > STALE_TTL_MS && !existing.rebuilding) {
    refreshIndex(projectPath).catch((err) => {
      log.warn('File index: background refresh failed', {
        namespace: 'file-index',
        projectPath,
        error: String(err),
      });
    });
  }

  return { files: existing.files, version: existing.version, fresh: false };
}

/**
 * Compute a delta since the given version, if possible. Returns null when the
 * caller's version is too old or the index hasn't been built yet, signalling
 * a full re-fetch is required.
 *
 * Current implementation only supports `since === current.version` (no-op) or
 * a full snapshot — incremental deltas across multiple versions are stored
 * implicitly in `files` and we don't keep change history. Clients still
 * benefit because the no-op case returns `{ unchanged: true }` cheaply.
 */
export function getFileIndexDelta(
  projectPath: string,
  sinceVersion: number,
): { unchanged: true; version: number } | null {
  const existing = indexes.get(projectPath);
  if (!existing) return null;
  if (existing.version === sinceVersion) {
    return { unchanged: true, version: existing.version };
  }
  return null;
}

/** Drop the cached index and stop watching. */
export function invalidateFileIndex(projectPath: string): void {
  const idx = indexes.get(projectPath);
  if (!idx) return;
  closeIndex(projectPath, idx);
  invalidateGitFilesCache(projectPath);
}

/**
 * Force a fresh rebuild from `git ls-files`. Used when the watcher reports
 * many changes at once or when external git ops happen (branch switch, pull).
 */
export async function refreshIndex(projectPath: string): Promise<void> {
  const existing = indexes.get(projectPath);
  if (existing?.rebuilding) {
    await existing.rebuilding;
    return;
  }
  invalidateGitFilesCache(projectPath);
  await buildIndex(projectPath);
}

// ── Build / refresh ──────────────────────────────────────────

async function buildIndex(projectPath: string): Promise<FileIndex> {
  let idx = indexes.get(projectPath);

  if (idx?.rebuilding) {
    await idx.rebuilding;
    return indexes.get(projectPath) ?? idx;
  }

  if (!idx) {
    idx = {
      files: [],
      version: 0,
      lastBuiltAt: 0,
      pending: { added: new Set(), removed: new Set() },
      watcher: null,
      watchDebounce: null,
      rebuildDebounce: null,
      rebuilding: null,
    };
    indexes.set(projectPath, idx);
  }

  const op = (async () => {
    const start = Date.now();
    let files: string[] = [];
    try {
      files = await resolveGitFiles(projectPath);
    } catch (err) {
      log.warn('File index: resolveGitFiles failed', {
        namespace: 'file-index',
        projectPath,
        error: String(err),
      });
    }

    files.sort();

    const i = indexes.get(projectPath);
    if (!i) return; // invalidated mid-build
    i.files = files;
    i.version += 1;
    i.lastBuiltAt = Date.now();
    i.pending.added.clear();
    i.pending.removed.clear();

    // Start watcher on first build
    if (!i.watcher) {
      i.watcher = startWatcher(projectPath);
    }

    log.debug('File index: built', {
      namespace: 'file-index',
      projectPath,
      fileCount: files.length,
      version: i.version,
      durationMs: Date.now() - start,
    });
  })();

  idx.rebuilding = op;
  try {
    await op;
  } finally {
    const after = indexes.get(projectPath);
    if (after) after.rebuilding = null;
  }

  return indexes.get(projectPath) ?? idx;
}

// ── Filesystem watcher ───────────────────────────────────────

function startWatcher(projectPath: string): FSWatcher | null {
  try {
    const w = watch(projectPath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const rel = typeof filename === 'string' ? filename : (filename as Buffer).toString('utf-8');
      onFsEvent(projectPath, rel);
    });
    w.on('error', (err) => {
      log.warn('File index: watcher error', {
        namespace: 'file-index',
        projectPath,
        error: String(err),
      });
    });
    return w;
  } catch (err) {
    log.warn('File index: failed to start watcher (falling back to git events only)', {
      namespace: 'file-index',
      projectPath,
      error: String(err),
    });
    return null;
  }
}

function onFsEvent(projectPath: string, relRaw: string): void {
  const idx = indexes.get(projectPath);
  if (!idx) return;

  // Normalise to POSIX separators (matches `git ls-files` output)
  const rel = sep === '\\' ? relRaw.split(sep).join('/') : relRaw;

  // Filter out paths in heavy build/dependency directories at any depth
  for (const seg of rel.split('/')) {
    if (HEAVY_IGNORED_DIRS.has(seg)) return;
  }

  // Stat will tell us whether it's an add/modify or a removal
  void stat(join(projectPath, rel))
    .then((st) => {
      if (!st.isFile()) return;
      idx.pending.added.add(rel);
      idx.pending.removed.delete(rel);
      scheduleApply(projectPath);
    })
    .catch(() => {
      idx.pending.removed.add(rel);
      idx.pending.added.delete(rel);
      scheduleApply(projectPath);
    });
}

function scheduleApply(projectPath: string): void {
  const idx = indexes.get(projectPath);
  if (!idx) return;

  if (idx.watchDebounce) clearTimeout(idx.watchDebounce);
  idx.watchDebounce = setTimeout(() => {
    idx.watchDebounce = null;
    applyPending(projectPath);
  }, WATCH_DEBOUNCE_MS);
}

function applyPending(projectPath: string): void {
  const idx = indexes.get(projectPath);
  if (!idx) return;

  const { added, removed } = idx.pending;
  if (added.size === 0 && removed.size === 0) return;

  // Heavy churn: schedule a debounced full rebuild instead of patching
  if (added.size + removed.size > 200) {
    idx.pending.added.clear();
    idx.pending.removed.clear();
    if (idx.rebuildDebounce) clearTimeout(idx.rebuildDebounce);
    idx.rebuildDebounce = setTimeout(() => {
      idx.rebuildDebounce = null;
      void refreshIndex(projectPath);
    }, REBUILD_DEBOUNCE_MS);
    return;
  }

  // Apply incrementally: build a new sorted array so we don't share refs.
  // We intentionally include `.gitignore`-ignored files (e.g. `.env`) so they
  // show up in the picker; the heavy-dir filter in `onFsEvent` already drops
  // `node_modules`/`dist`/etc. Any false positives wash out on the next
  // git-driven rebuild.
  const present = new Set(idx.files);
  for (const rel of removed) present.delete(rel);
  for (const rel of added) present.add(rel);
  idx.pending.added.clear();
  idx.pending.removed.clear();

  const next = Array.from(present);
  next.sort();
  idx.files = next;
  idx.version += 1;
}

// ── Lifecycle ────────────────────────────────────────────────

function closeIndex(projectPath: string, idx: FileIndex): void {
  if (idx.watchDebounce) clearTimeout(idx.watchDebounce);
  if (idx.rebuildDebounce) clearTimeout(idx.rebuildDebounce);
  if (idx.watcher) {
    try {
      idx.watcher.close();
    } catch {
      // ignore
    }
  }
  indexes.delete(projectPath);
}

export function closeAllFileIndexes(): void {
  for (const [path, idx] of indexes) closeIndex(path, idx);
}

// React to git events (branch switch, pull, etc.) — full rebuild
threadEventBus.on('git:changed', (event) => {
  // Use project path, not worktree path — the index is keyed per project root.
  // We could also key by cwd to support per-worktree indexes; for now the
  // project root is what FileSearchDialog asks about.
  const root = projectRootFor(event.projectId, event.cwd);
  if (!root) return;

  const idx = indexes.get(root);
  if (!idx) return;

  if (idx.rebuildDebounce) clearTimeout(idx.rebuildDebounce);
  idx.rebuildDebounce = setTimeout(() => {
    idx.rebuildDebounce = null;
    void refreshIndex(root);
  }, REBUILD_DEBOUNCE_MS);
});

/**
 * Resolve the project root for a `git:changed` event. We currently key the
 * cache by whatever `cwd` is — for `local`-mode threads that's the project
 * path; for worktree threads it's the worktree path. We want to invalidate
 * any index that might be affected.
 */
function projectRootFor(_projectId: string, cwd: string): string | null {
  // Walk up from `cwd` matching any keys in `indexes`.
  if (indexes.has(cwd)) return cwd;
  for (const key of indexes.keys()) {
    const r = relative(key, cwd);
    if (r && !r.startsWith('..') && !r.startsWith(sep === '\\' ? '..\\' : '../')) {
      return key;
    }
  }
  return null;
}

shutdownManager.register('file-index-service', () => closeAllFileIndexes(), ShutdownPhase.SERVICES);
