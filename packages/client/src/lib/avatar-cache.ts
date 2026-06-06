import { useEffect, useState } from 'react';

import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('avatar-cache');

/**
 * TTL for a cached avatar blob. Short on purpose: avatars rarely change, but a
 * 1-minute window is enough to collapse the burst of identical requests a
 * virtualized commit list fires while you scroll (each row mount would
 * otherwise re-hit GitHub, which rate-limits `github.com/<user>.png` with 429s).
 */
const TTL_MS = 60_000;

/** Soft cap on distinct cached avatars; oldest are evicted (and revoked) past it. */
const MAX_ENTRIES = 300;

interface Entry {
  /** `blob:` object URL for the fetched image bytes. */
  objectUrl: string;
  /** Epoch ms after which the entry is stale and gets refetched. */
  expiresAt: number;
}

// Module-level so the cache is shared across every mounted component and
// survives row remounts. Keyed by the remote avatar URL.
const cache = new Map<string, Entry>();
// In-flight fetches, so N components asking for the same URL share one request.
const inflight = new Map<string, Promise<string | null>>();

function getFresh(url: string): string | null {
  const e = cache.get(url);
  if (e && e.expiresAt > Date.now()) return e.objectUrl;
  return null;
}

function evictIfNeeded(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const old = cache.get(oldestKey);
    if (old) URL.revokeObjectURL(old.objectUrl);
    cache.delete(oldestKey);
  }
}

async function load(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) {
      log.debug('avatar fetch non-ok', { status: res.status });
      return null;
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    // Replace + revoke any prior (now-expired) entry for this URL.
    const prev = cache.get(url);
    if (prev) URL.revokeObjectURL(prev.objectUrl);
    cache.set(url, { objectUrl, expiresAt: Date.now() + TTL_MS });
    evictIfNeeded();
    return objectUrl;
  } catch (err) {
    // CORS failure / network error — caller falls back to the direct URL.
    log.debug('avatar fetch failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Resolve a remote avatar URL to a locally-cached `blob:` object URL with a
 * short TTL (see {@link TTL_MS}). Within the TTL the image is served from an
 * in-memory blob — zero network — so a virtualized list remounting rows doesn't
 * re-hit GitHub. Falls back to the original URL if the fetch can't be cached
 * (e.g. CORS), so the `<img>` / SVG `<image>` still renders either way.
 *
 * Returns `undefined` only while the very first fetch for an uncached URL is in
 * flight (callers show their avatar-less fallback briefly).
 */
export function useCachedAvatar(url: string | undefined | null): string | undefined {
  const [resolved, setResolved] = useState<string | undefined>(() =>
    url ? (getFresh(url) ?? undefined) : undefined,
  );

  useEffect(() => {
    if (!url) {
      setResolved(undefined);
      return;
    }
    const fresh = getFresh(url);
    if (fresh) {
      setResolved(fresh);
      return;
    }
    setResolved(undefined);
    let active = true;
    let promise = inflight.get(url);
    if (!promise) {
      promise = load(url).finally(() => inflight.delete(url));
      inflight.set(url, promise);
    }
    promise.then((obj) => {
      // On success use the cached blob; on failure fall back to the direct URL
      // so the image still loads (just uncached) via the browser.
      if (active) setResolved(obj ?? url);
    });
    return () => {
      active = false;
    };
  }, [url]);

  return resolved;
}
