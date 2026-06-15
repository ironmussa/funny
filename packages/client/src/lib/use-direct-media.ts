import { useEffect, useState } from 'react';

import { createClientLogger } from '@/lib/client-logger';
import { isExternalUrl, resolveImageSrc } from '@/lib/raw-file-src';

const log = createClientLogger('direct-media');

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
 * (minutes); we cache to avoid re-signing the same media on every re-render, and
 * let them expire naturally — a redemption past expiry just 401s and the next
 * mount re-signs.
 */
const signedCache = new Map<string, string>();

/** Test seam: clear the latched flag + cache between cases. */
export function __resetDirectMediaForTests(): void {
  directMediaDisabled = false;
  signedCache.clear();
}

async function signMedia(path: string): Promise<string | null> {
  if (directMediaDisabled) return null;
  const cached = signedCache.get(path);
  if (cached) return cached;
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
    return data.url;
  } catch (e) {
    log.debug('direct-media sign failed — using proxied url', { error: String(e) });
    return null;
  }
}

/**
 * Resolve a media `src` to the best URL the browser can load:
 *  - external / data URL → returned unchanged.
 *  - local runner path → the proxied `/api/files/raw` URL IMMEDIATELY, then
 *    upgraded to a signed direct-runner URL (transport C) when the runner
 *    supports it — so the bytes stream straight from the runner instead of
 *    through the WS tunnel. Falls back silently to the proxied URL otherwise.
 *
 * Returns `undefined` only when `src` is empty/missing.
 */
export function useResolvedMediaSrc(src?: string): string | undefined {
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

  return resolved;
}
