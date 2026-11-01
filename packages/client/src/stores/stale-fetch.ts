/** Default freshness window for cached runner/infra lists. */
const STALE_MS = 60_000;

interface StaleFetchState {
  loadedAt: number;
  loading: boolean;
}

/**
 * Whether a cached `fetch(force)` should be skipped: a request is already in
 * flight, or the cache is still fresh and the caller did not force a refresh.
 */
export function shouldSkipFetch(s: StaleFetchState, force: boolean, staleMs = STALE_MS): boolean {
  if (s.loading) return true;
  return !force && !!s.loadedAt && Date.now() - s.loadedAt < staleMs;
}
