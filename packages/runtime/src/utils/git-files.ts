import type { Dirent } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';

import { getNativeGit, gitRead } from '@funny/core/git';

import { log } from '../lib/logger.js';
import { startSpan } from '../lib/telemetry.js';

// ─── Cache for resolveGitFiles ──────────────────────────────
const GIT_FILES_CACHE_TTL = 5_000; // 5 seconds

/**
 * Heavy build/dependency directories we never want to surface in the file
 * picker, even when they're not in `.gitignore`. Keeps `.env`-style ignored
 * files visible without exploding the index with `node_modules` contents.
 *
 * MUST stay in sync with `HEAVY_DIRS` in
 * `packages/native-git/src/list_files.rs` — the native path prunes during
 * traversal (cheap), the watcher path here filters fs events (cheap), and
 * the CLI fallback path post-filters (the historical reason this existed).
 */
export const HEAVY_IGNORED_DIRS = new Set([
  // JS / web
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.vite',
  '.parcel-cache',
  // git internals
  '.git',
  // Unity
  'Library',
  'Temp',
  'Logs',
  // Rust
  'target',
  // .NET / Java
  'bin',
  'obj',
  '.gradle',
  // Python
  '__pycache__',
  '.venv',
  'venv',
  // Misc vendored deps
  'vendor',
]);

function isHeavyIgnored(rel: string): boolean {
  const segs = rel.split('/');
  for (const seg of segs) {
    if (HEAVY_IGNORED_DIRS.has(seg)) return true;
  }
  return false;
}

interface CacheEntry {
  files: string[];
  ts: number;
}

const fileCache = new Map<string, CacheEntry>();
const inflightRequests = new Map<string, Promise<string[]>>();

/** Invalidate cached file lists for a specific directory, or all entries. */
export function invalidateGitFilesCache(cwd?: string): void {
  if (cwd) {
    fileCache.delete(cwd);
    for (const key of fileCache.keys()) {
      if (key.startsWith(cwd + '/')) fileCache.delete(key);
    }
  } else {
    fileCache.clear();
  }
}

/**
 * Run `git ls-files` in a directory and return the raw file list.
 *
 * Returns BOTH tracked/untracked-not-ignored files AND `.gitignore`-ignored
 * files (e.g. `.env`, local config). Files inside heavy build dirs like
 * `node_modules`, `dist`, `.next`, etc. are filtered out so the index stays
 * usable.
 *
 * Uses gitRead (read pool, limit 20) instead of execute (general pool, limit 6).
 */
export async function gitLsFiles(cwd: string): Promise<string[]> {
  const [tracked, ignored] = await Promise.all([
    gitRead(['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd,
      reject: false,
      timeout: 10_000,
    }),
    gitRead(['ls-files', '--others', '--ignored', '--exclude-standard'], {
      cwd,
      reject: false,
      timeout: 10_000,
    }),
  ]);

  if (tracked.exitCode !== 0) {
    log.warn('git-files: ls-files (tracked) failed', {
      namespace: 'git-files',
      cwd,
      exitCode: tracked.exitCode,
    });
    return [];
  }

  const out = new Set<string>();
  for (const line of tracked.stdout.split('\n')) {
    const f = line.trim();
    // Tracked files inside heavy dirs (e.g. someone committed `dist/`) are
    // dropped too — matches the native backend, which prunes by path
    // segments regardless of tracked/ignored state.
    if (f && !isHeavyIgnored(f)) out.add(f);
  }

  if (ignored.exitCode === 0) {
    for (const line of ignored.stdout.split('\n')) {
      const f = line.trim();
      if (f && !isHeavyIgnored(f)) out.add(f);
    }
  } else {
    log.warn('git-files: ls-files (ignored) failed', {
      namespace: 'git-files',
      cwd,
      exitCode: ignored.exitCode,
    });
  }

  return Array.from(out);
}

/**
 * Recursive fs walk used as a fallback when the directory is not a git repo
 * (e.g. scratch threads). Returns sorted relative POSIX paths, pruning any
 * entries inside `HEAVY_IGNORED_DIRS` and dot-directories like `.git`.
 *
 * Symlinks are not followed to avoid cycles. Errors on individual entries
 * (e.g. permission denied) are logged and skipped rather than aborting.
 */
export async function walkDirectoryTree(cwd: string): Promise<string[]> {
  const span = startSpan('file-index.list-files', {
    attributes: { backend: 'fs-walk', cwd },
  });
  const out: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true, encoding: 'utf8' })) as Dirent[];
    } catch (err) {
      log.warn('git-files: walkDirectoryTree readdir failed', {
        namespace: 'git-files',
        cwd: dir,
        error: String(err),
      });
      return;
    }

    const subdirs: { name: string; rel: string }[] = [];
    for (const entry of entries) {
      const name = entry.name;
      if (HEAVY_IGNORED_DIRS.has(name)) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        subdirs.push({ name, rel });
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }

    await Promise.all(subdirs.map(({ name, rel }) => walk(join(dir, name), rel)));
  }

  try {
    await walk(cwd, '');
    out.sort();
    span.attributes['file.count'] = out.length;
    span.end('ok');
    return out;
  } catch (err) {
    span.end('error', String(err));
    throw err;
  }
}

/**
 * Recursively resolve files from `git ls-files`.
 * Results are cached with a 5-second TTL. Concurrent requests for the same
 * path coalesce into a single git process.
 */
export async function resolveGitFiles(cwd: string, prefix = ''): Promise<string[]> {
  // Only cache top-level calls; recursive calls are part of the same operation
  if (prefix === '') {
    const cached = fileCache.get(cwd);
    if (cached && Date.now() - cached.ts < GIT_FILES_CACHE_TTL) {
      return cached.files;
    }

    // In-flight deduplication: share the same Promise if already running
    const inflight = inflightRequests.get(cwd);
    if (inflight) return inflight;

    const promise = _resolveTopLevel(cwd)
      .then((files) => {
        fileCache.set(cwd, { files, ts: Date.now() });
        inflightRequests.delete(cwd);
        return files;
      })
      .catch((err) => {
        inflightRequests.delete(cwd);
        throw err;
      });

    inflightRequests.set(cwd, promise);
    return promise;
  }

  return _resolveGitFilesInner(cwd, prefix);
}

/**
 * Top-level file listing. Tries the native gitoxide-backed implementation
 * first (10–50× faster on big monorepos because it walks the worktree without
 * shelling out and prunes heavy build dirs in `can_recurse`). Falls back to
 * the CLI pipeline on any error.
 */
async function _resolveTopLevel(cwd: string): Promise<string[]> {
  const native = getNativeGit();
  if (native?.listFiles) {
    const span = startSpan('file-index.list-files', {
      attributes: { backend: 'native', cwd },
    });
    try {
      const files = await native.listFiles(cwd, { includeIgnored: true });
      span.attributes['file.count'] = files.length;
      span.end('ok');
      return files;
    } catch (err) {
      span.end('error', String(err));
      log.warn('git-files: native listFiles failed, falling back to CLI', {
        namespace: 'git-files',
        cwd,
        error: String(err),
      });
    }
  }

  const span = startSpan('file-index.list-files', {
    attributes: { backend: 'cli', cwd },
  });
  try {
    const files = await _resolveGitFilesInner(cwd, '');
    span.attributes['file.count'] = files.length;
    span.end('ok');
    return files;
  } catch (err) {
    span.end('error', String(err));
    throw err;
  }
}

/** Inner implementation without caching (handles recursion). */
async function _resolveGitFilesInner(cwd: string, prefix: string): Promise<string[]> {
  const entries = await gitLsFiles(cwd);
  const resolved: string[] = [];
  const nestedDirs: string[] = [];

  for (const entry of entries) {
    if (entry.endsWith('/')) {
      nestedDirs.push(entry.replace(/\/$/, ''));
    } else {
      resolved.push(prefix + entry);
    }
  }

  // Resolve nested git repos in parallel
  if (nestedDirs.length > 0) {
    const nested = await Promise.all(
      nestedDirs.map((dir) => _resolveGitFilesInner(join(cwd, dir), prefix + dir + '/')),
    );
    for (const files of nested) {
      resolved.push(...files);
    }
  }

  return resolved;
}
