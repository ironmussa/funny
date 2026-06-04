import { useThreadStore } from '@/stores/thread-store';
import type { ThreadWithMessages } from '@/stores/thread-types';

import { useActiveThreadId } from './use-active-thread-id';

/**
 * Cache lookup for a thread's hydrated payload (`threadDataById`). Returns
 * `null` when the thread isn't loaded yet (no error tri-state — the store
 * tracks loading via `selectThread`'s in-flight slot, not per-id error).
 *
 * Part of the route-driven-threads migration — see
 * `docs/rfc/route-driven-threads.md` (Phase 3). This is the eventual drop-in
 * replacement for the `selectedThreadId`-keyed `useActiveThread()` once readers
 * derive the active id from the URL.
 */
export function useThreadData(id: string | null | undefined): ThreadWithMessages | null {
  return useThreadStore((s) => (id ? (s.threadDataById[id] ?? null) : null));
}

/**
 * The active thread's payload, keyed off the URL (not `selectedThreadId`).
 * URL-derived sibling of the store's `useActiveThread()`; same `| null` shape
 * so it can replace it as consumers migrate.
 */
export function useActiveThreadData(): ThreadWithMessages | null {
  return useThreadData(useActiveThreadId());
}
