import { create } from 'zustand';

import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { loadCachedFileIndex, saveCachedFileIndex } from '@/lib/file-index-db';

const log = createClientLogger('file-index-store');

interface FileIndexEntry {
  files: string[];
  version: number;
  /** Loaded from IDB but not yet revalidated against the server. */
  stale: boolean;
}

/**
 * Lookup target for an index. `path` is the absolute project / worktree
 * path; `threadId` lets the server resolve the cwd (used for scratch and
 * any other thread where the client doesn't know the path up front). When
 * resolving by threadId, the entry is cached under the server-returned
 * `basePath` so a follow-up `path` lookup hits the same cache.
 */
export type FileIndexTarget = { path: string } | { threadId: string };

interface FileIndexState {
  byPath: Record<string, FileIndexEntry>;
  inflight: Record<string, Promise<{ entry: FileIndexEntry | null; basePath: string | null }>>;
  /**
   * Ensure an index is loaded for `target`. Hydrates from IndexedDB
   * synchronously if `target.path` is available, then revalidates against
   * the server in the background. Returns the current entry and the
   * resolved `basePath` (the path the entry is keyed under in `byPath`).
   */
  ensureIndex: (
    target: FileIndexTarget,
  ) => Promise<{ entry: FileIndexEntry | null; basePath: string | null }>;
  /** Force a server fetch (e.g. user pressed refresh). */
  refresh: (
    target: FileIndexTarget,
  ) => Promise<{ entry: FileIndexEntry | null; basePath: string | null }>;
}

async function fetchFromServer(
  target: FileIndexTarget,
  sinceVersion?: number,
): Promise<{ files: string[]; version: number; basePath?: string } | { basePath?: string } | null> {
  const apiArg =
    'path' in target
      ? { path: target.path, since: sinceVersion }
      : { threadId: target.threadId, since: sinceVersion };
  const result = await api.getFileIndex(apiArg);
  if (result.isErr()) {
    log.warn('file-index fetch failed', {
      target,
      error: result.error.message,
    });
    return null;
  }
  if ('unchanged' in result.value && result.value.unchanged) {
    return result.value.basePath ? { basePath: result.value.basePath } : {};
  }
  // Type narrowed: must have files when not unchanged
  if ('files' in result.value) {
    return {
      files: result.value.files,
      version: result.value.version,
      basePath: result.value.basePath,
    };
  }
  return null;
}

function targetKey(target: FileIndexTarget): string {
  return 'path' in target ? target.path : `thread:${target.threadId}`;
}

export const useFileIndexStore = create<FileIndexState>((set, get) => ({
  byPath: {},
  inflight: {},

  ensureIndex: async (target) => {
    const knownPath = 'path' in target ? target.path : undefined;
    const state = get();
    if (knownPath) {
      const existing = state.byPath[knownPath];
      if (existing && !existing.stale) return { entry: existing, basePath: knownPath };
    }

    const key = targetKey(target);
    const inflight = state.inflight[key];
    if (inflight) return inflight;

    const op = (async (): Promise<{ entry: FileIndexEntry | null; basePath: string | null }> => {
      // 1. Try IDB cache for instant cold-start (only when the path is known)
      let cached: FileIndexEntry | null = null;
      if (knownPath) {
        const idbHit = await loadCachedFileIndex(knownPath);
        if (idbHit) {
          cached = { files: idbHit.files, version: idbHit.version, stale: true };
          set((s) => ({ byPath: { ...s.byPath, [knownPath]: cached! } }));
        }
      }

      // 2. Revalidate against server (delta if possible)
      const fresh = await fetchFromServer(target, cached?.version);

      // Resolved basePath: prefer server-reported, fall back to the input path
      const resolvedBase =
        fresh && 'basePath' in fresh && fresh.basePath ? fresh.basePath : (knownPath ?? null);

      if (fresh && 'files' in fresh && fresh.files) {
        const entry: FileIndexEntry = {
          files: fresh.files,
          version: fresh.version,
          stale: false,
        };
        if (resolvedBase) {
          set((s) => ({ byPath: { ...s.byPath, [resolvedBase]: entry } }));
          void saveCachedFileIndex(resolvedBase, fresh.files, fresh.version);
        }
        return { entry, basePath: resolvedBase };
      }

      // No fresh data — either server said unchanged, or fetch failed
      if (cached && knownPath) {
        const entry: FileIndexEntry = { ...cached, stale: false };
        set((s) => ({ byPath: { ...s.byPath, [knownPath]: entry } }));
        return { entry, basePath: knownPath };
      }
      // Thread-based lookup with no fresh data and no cache: still report
      // the basePath the server told us about so callers can show "empty".
      if (resolvedBase) {
        const existing = get().byPath[resolvedBase];
        return { entry: existing ?? null, basePath: resolvedBase };
      }
      return { entry: null, basePath: null };
    })().finally(() => {
      set((s) => {
        const next = { ...s.inflight };
        delete next[key];
        return { inflight: next };
      });
    });

    set((s) => ({ inflight: { ...s.inflight, [key]: op } }));
    return op;
  },

  refresh: async (target) => {
    if ('path' in target) {
      const basePath = target.path;
      set((s) => {
        if (!s.byPath[basePath]) return s;
        return { byPath: { ...s.byPath, [basePath]: { ...s.byPath[basePath], stale: true } } };
      });
    }
    return get().ensureIndex(target);
  },
}));
