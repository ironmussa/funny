import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';

import { parseRoute } from './route-parser';

/**
 * The active thread id — derived from the URL, the single source of truth for
 * which thread is active. Covers both `/projects/:pid/threads/:id` and
 * `/scratch/:id` routes (see `parseRoute`).
 *
 * Prefer this over reading `selectedThreadId` from the store: the URL updates
 * synchronously on navigate, whereas `selectedThreadId` is a store pointer that
 * the legacy async `selectThread` keeps roughly in sync. Reading the URL avoids
 * the transient divergence the route-sync invariant guard exists to paper over.
 *
 * Part of the route-driven-threads migration — see
 * `docs/route-driven-threads-plan.md` (Phase 3).
 */
export function useActiveThreadId(): string | null {
  const { pathname } = useLocation();
  return useMemo(() => parseRoute(pathname).threadId ?? null, [pathname]);
}
