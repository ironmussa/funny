import { renderHook, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { __resetDirectMediaForTests, useResolvedMediaSrc } from '@/lib/use-direct-media';

const TTL = 5 * 60 * 1000; // server's MEDIA_URL_DEFAULT_TTL_MS

/** Build a signed direct-runner URL with a given expiry + identifying tag. */
function signedUrl(exp: number, tag: string): string {
  return `https://runner.test/api/files/raw-signed?path=%2Fx.png&u=u&exp=${exp}&sig=${tag}`;
}

function mockSign(...urls: string[]) {
  const fetchMock = vi.fn();
  for (const url of urls) {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ url }) } as Response);
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetDirectMediaForTests();
});

describe('useResolvedMediaSrc signed-URL cache', () => {
  test('reuses a still-fresh cached signed URL without re-signing', async () => {
    const now = Date.now();
    const fetchMock = mockSign(signedUrl(now + TTL, 'only'), signedUrl(now + TTL, 'unused'));

    const first = renderHook(() => useResolvedMediaSrc('/x.png'));
    await waitFor(() => expect(first.result.current.src).toContain('sig=only'));
    first.unmount();

    const second = renderHook(() => useResolvedMediaSrc('/x.png'));
    await waitFor(() => expect(second.result.current.src).toContain('sig=only'));
    // Second mount served from cache — no second /api/media/sign round-trip.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('re-signs instead of replaying a cached URL that is within the refresh skew', async () => {
    const now = Date.now();
    // First sign returns a URL only ~10s from expiry (inside the 30s skew), so on
    // the next read it must be treated as stale and re-signed — the regression:
    // before the fix the expired URL was replayed and 401'd ("…expired").
    const fetchMock = mockSign(signedUrl(now + 10_000, 'stale'), signedUrl(now + TTL, 'fresh'));

    const first = renderHook(() => useResolvedMediaSrc('/x.png'));
    await waitFor(() => expect(first.result.current.src).toContain('sig=stale'));
    first.unmount();

    const second = renderHook(() => useResolvedMediaSrc('/x.png'));
    await waitFor(() => expect(second.result.current.src).toContain('sig=fresh'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('onError falls back from a signed URL to the proxied URL and retries', async () => {
    const now = Date.now();
    mockSign(signedUrl(now + TTL, 'direct'));

    const { result } = renderHook(() => useResolvedMediaSrc('/x.png'));
    // Upgrades to the signed direct URL…
    await waitFor(() => expect(result.current.src).toContain('sig=direct'));

    // …and when it fails, onError reports a recoverable fallback (true) and
    // swaps back to the proxied /api/files/raw URL.
    let recovered = false;
    act(() => {
      recovered = result.current.onError();
    });
    expect(recovered).toBe(true);
    await waitFor(() => expect(result.current.src).toBe('/api/files/raw?path=%2Fx.png'));

    // A second failure on the proxied URL is a genuine error (false).
    expect(result.current.onError()).toBe(false);
  });
});
