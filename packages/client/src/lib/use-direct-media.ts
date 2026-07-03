import { useCallback, useEffect, useState } from 'react';

import { createClientLogger } from '@/lib/client-logger';
import { isExternalUrl, resolveImageSrc } from '@/lib/raw-file-src';

const log = createClientLogger('direct-media');

/**
 * Re-sign this long BEFORE a signed URL's real expiry. The server mints signed
 * media URLs with a short TTL (`MEDIA_URL_DEFAULT_TTL_MS`, 5 min). Because we
 * cache them per page session, a URL minted minutes ago can be replayed past
 * its TTL and 401 ("Invalid signed media URL: expired") — the browser then
 * shows a broken image. Treating anything within this skew as stale forces a
 * fresh sign before that happens.
 */
const SIGNED_URL_REFRESH_SKEW_MS = 30_000;
const MAX_SIGNED_CACHE_ENTRIES = 200;

/** True when a cached signed URL still has comfortably more than the skew left. */
function signedUrlIsFresh(url: string): boolean {
  try {
    // `exp` is MEDIA_SIG_PARAMS.expires — a unix-ms instant in the query string.
    const exp = Number(new URL(url).searchParams.get('exp'));
    return Number.isFinite(exp) && exp - Date.now() > SIGNED_URL_REFRESH_SKEW_MS;
  } catch {
    return false;
  }
}

/**
 * Session-level capability flag (transport C). The server answers
 * `/api/media/sign` with `{ url: null }` whenever the user's runner did not
 * advertise a browser-reachable `publicMediaUrl`. After the FIRST such answer we
 * latch this flag so every later media skips the round-trip entirely and uses
 * the proxied `/api/files/raw` URL (transport A) directly — zero added latency
 * when direct media is disabled. Reset on page reload.
 */
let directMediaDisabled = false;

/**
 * path → signed-URL cache for this page session. Signed URLs are short-lived
 * (minutes); we cache to avoid re-signing the same media on every re-render, but
 * MUST refresh before expiry — see `signedUrlIsFresh` / `SIGNED_URL_REFRESH_SKEW_MS`.
 * Returning an expired entry replays a 401 and breaks the image.
 */
const signedCache = new Map<string, string>();

function pruneSignedCache(): void {
  for (const [path, url] of signedCache) {
    if (!signedUrlIsFresh(url)) signedCache.delete(path);
  }

  while (signedCache.size > MAX_SIGNED_CACHE_ENTRIES) {
    const oldest = signedCache.keys().next();
    if (oldest.done) break;
    signedCache.delete(oldest.value);
  }
}

/** Test seam: clear the latched flag + cache between cases. */
export function __resetDirectMediaForTests(): void {
  directMediaDisabled = false;
  signedCache.clear();
}

export function __cacheSignedMediaForTests(path: string, url: string): void {
  signedCache.set(path, url);
  pruneSignedCache();
}

export function __hasSignedMediaForTests(path: string): boolean {
  return signedCache.has(path);
}

async function signMedia(path: string): Promise<string | null> {
  if (directMediaDisabled) return null;
  const cached = signedCache.get(path);
  if (cached) {
    if (signedUrlIsFresh(cached)) {
      signedCache.delete(path);
      signedCache.set(path, cached);
      return cached;
    }
    // Expired or within the refresh skew — drop it and mint a fresh one below.
    signedCache.delete(path);
  }
  try {
    const res = await fetch('/api/media/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { url?: string | null };
    if (!data.url) {
      // Runner has no public media URL → stop asking for the rest of the session.
      directMediaDisabled = true;
      return null;
    }
    signedCache.set(path, data.url);
    pruneSignedCache();
    return data.url;
  } catch (e) {
    log.debug('direct-media sign failed — using proxied url', { error: String(e) });
    return null;
  }
}

export interface ResolvedMedia {
  /** Best URL the browser can load right now (proxied, then upgraded to signed). */
  src: string | undefined;
  /**
   * Call from the media element's `onError`. When the current URL is an upgraded
   * signed direct-runner URL that just failed (expired at redemption, host
   * unreachable, …), this evicts it and falls back to the reliable proxied
   * `/api/files/raw` URL, returning `true` so the caller retries instead of
   * showing an error. Returns `false` when already on the proxied/external URL
   * (a genuine failure the caller should surface).
   */
  onError: () => boolean;
}

/**
 * Resolve a media `src` to the best URL the browser can load:
 *  - external / data URL → returned unchanged.
 *  - local runner path → the proxied `/api/files/raw` URL IMMEDIATELY, then
 *    upgraded to a signed direct-runner URL (transport C) when the runner
 *    supports it — so the bytes stream straight from the runner instead of
 *    through the WS tunnel. Falls back silently to the proxied URL otherwise.
 *
 * `src` is `undefined` only when the input is empty/missing.
 */
export function useResolvedMediaSrc(src?: string): ResolvedMedia {
  const proxied = resolveImageSrc(src);
  const [resolved, setResolved] = useState(proxied);

  useEffect(() => {
    setResolved(proxied);
    // Only local runner paths can be signed; external URLs load directly.
    if (!src || isExternalUrl(src) || directMediaDisabled) return;
    let cancelled = false;
    void signMedia(src).then((url) => {
      if (!cancelled && url) setResolved(url);
    });
    return () => {
      cancelled = true;
    };
  }, [src, proxied]);

  const onError = useCallback(() => {
    // We're showing an upgraded signed URL and it failed — drop it and fall back
    // to the proxied URL before the caller surfaces an error. A stale cache entry
    // is also evicted so the next sign mints a fresh one.
    if (src && !isExternalUrl(src) && proxied && resolved !== proxied) {
      signedCache.delete(src);
      setResolved(proxied);
      return true;
    }
    return false;
  }, [src, proxied, resolved]);

  return { src: resolved, onError };
}
