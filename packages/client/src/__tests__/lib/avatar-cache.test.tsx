import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

import { renderHook, waitFor } from '@testing-library/react';

import { useCachedAvatar } from '@/lib/avatar-cache';

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

describe('useCachedAvatar', () => {
  let resolvers: Map<string, (res: Response) => void>;

  beforeEach(() => {
    resolvers = new Map();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (input) => new Promise<Response>((resolve) => resolvers.set(String(input), resolve)),
    );
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:avatar-${++n}`);
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
  });

  test('resolves a URL to its blob, starts a new URL empty, and serves a cached URL at once', async () => {
    const a = `https://example.test/a-${Math.random()}.png`;
    const b = `https://example.test/b-${Math.random()}.png`;
    const { result, rerender } = renderHook(({ url }) => useCachedAvatar(url), {
      initialProps: { url: a },
    });
    expect(result.current).toBeUndefined();
    resolvers.get(a)?.(new Response('a'));
    await waitFor(() => expect(result.current).toBe('blob:avatar-1'));

    // A new URL does not keep showing the previous avatar while it loads.
    rerender({ url: b });
    expect(result.current).toBeUndefined();
    resolvers.get(b)?.(new Response('b'));
    await waitFor(() => expect(result.current).toBe('blob:avatar-2'));

    // Back to a cached URL: served from the cache in the same render, no new fetch.
    rerender({ url: a });
    expect(result.current).toBe('blob:avatar-1');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test('falls back to the direct URL when the fetch fails', async () => {
    const c = `https://example.test/c-${Math.random()}.png`;
    const { result } = renderHook(() => useCachedAvatar(c));
    resolvers.get(c)?.(new Response('', { status: 404 }));
    await waitFor(() => expect(result.current).toBe(c));
  });

  test('returns undefined without a URL', () => {
    const { result } = renderHook(() => useCachedAvatar(null));
    expect(result.current).toBeUndefined();
  });
});
