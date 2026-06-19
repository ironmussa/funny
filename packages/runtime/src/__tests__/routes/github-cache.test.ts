import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { FRESH_TTL_MS, _resetGithubCache } from '../../routes/github/github-cache.js';
import { githubApiFetch } from '../../routes/github/helpers.js';

const TOKEN = 'gho_test_token';

function ghResponse(
  body: unknown,
  init: { status?: number; etag?: string; link?: string; headers?: Record<string, string> } = {},
): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', ...init.headers });
  if (init.etag) headers.set('ETag', init.etag);
  if (init.link) headers.set('Link', init.link);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

describe('githubApiFetch caching', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  /** Responses returned, in order, for calls to api.github.com. */
  let ghQueue: Response[];

  /**
   * The runtime logger's Abbacchio transport also goes through global `fetch`
   * (e.g. shipping the cooldown warning), so the mock must distinguish GitHub
   * traffic from log traffic: queued responses are consumed only by GitHub
   * calls, and log shipments get a benign 200 without draining the queue.
   */
  const githubCalls = () =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes('api.github.com'));

  beforeEach(() => {
    _resetGithubCache();
    vi.useFakeTimers();
    ghQueue = [];
    fetchMock = vi.fn(async (url: string) => {
      if (!String(url).includes('api.github.com')) return new Response('{}', { status: 200 });
      const next = ghQueue.shift();
      if (!next) throw new Error(`unexpected GitHub call: ${url}`);
      return next;
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('serves the fresh window from cache without a second network call', async () => {
    ghQueue.push(ghResponse([{ number: 1 }], { etag: 'W/"abc"' }));

    const first = await githubApiFetch('/repos/o/r/pulls', TOKEN);
    expect(await first.json()).toEqual([{ number: 1 }]);
    expect(githubCalls()).toHaveLength(1);

    // Within FRESH_TTL_MS — no network call, body re-served.
    vi.advanceTimersByTime(FRESH_TTL_MS - 1);
    const second = await githubApiFetch('/repos/o/r/pulls', TOKEN);
    expect(githubCalls()).toHaveLength(1);
    expect(second.headers.get('X-Funny-Cache')).toBe('hit');
    expect(await second.json()).toEqual([{ number: 1 }]);
  });

  test('revalidates with If-None-Match after the TTL and serves cache on 304', async () => {
    ghQueue.push(ghResponse([{ number: 1 }], { etag: 'W/"abc"' }));
    await githubApiFetch('/repos/o/r/pulls', TOKEN);

    // 304 carries no body — the cached body must be returned instead.
    ghQueue.push(new Response(null, { status: 304 }));
    vi.advanceTimersByTime(FRESH_TTL_MS + 1);
    const res = await githubApiFetch('/repos/o/r/pulls', TOKEN);

    const calls = githubCalls();
    expect(calls).toHaveLength(2);
    const conditionalHeaders = calls[1][1].headers as Headers;
    expect(conditionalHeaders.get('If-None-Match')).toBe('W/"abc"');
    expect(await res.json()).toEqual([{ number: 1 }]);
  });

  test('varies GET cache entries by Accept header', async () => {
    ghQueue.push(new Response('raw-file', { status: 200 }));
    const raw = await githubApiFetch('/repos/o/r/contents/file.txt?ref=main', TOKEN, {
      headers: { Accept: 'application/vnd.github.raw+json' },
    });
    expect(await raw.text()).toBe('raw-file');

    ghQueue.push(ghResponse({ content: 'cmF3LWZpbGU=' }));
    const json = await githubApiFetch('/repos/o/r/contents/file.txt?ref=main', TOKEN);

    expect(githubCalls()).toHaveLength(2);
    expect(await json.json()).toEqual({ content: 'cmF3LWZpbGU=' });
  });

  test('enters a cooldown on 429 and serves stale cache while it lasts', async () => {
    ghQueue.push(ghResponse([{ number: 1 }], { etag: 'W/"abc"' }));
    await githubApiFetch('/repos/o/r/pulls', TOKEN);

    // After the TTL, GitHub rate-limits us with a Retry-After.
    ghQueue.push(
      ghResponse({ message: 'slow down' }, { status: 429, headers: { 'Retry-After': '30' } }),
    );
    vi.advanceTimersByTime(FRESH_TTL_MS + 1);
    const limited = await githubApiFetch('/repos/o/r/pulls', TOKEN);
    // Stale cache is preferred over surfacing the error.
    expect(await limited.json()).toEqual([{ number: 1 }]);
    expect(githubCalls()).toHaveLength(2);

    // Still in cooldown → no further network calls, cache keeps serving.
    vi.advanceTimersByTime(FRESH_TTL_MS + 1);
    const stillCached = await githubApiFetch('/repos/o/r/pulls', TOKEN);
    expect(githubCalls()).toHaveLength(2);
    expect(await stillCached.json()).toEqual([{ number: 1 }]);
  });

  test('returns 429 with Retry-After when rate-limited and nothing is cached', async () => {
    ghQueue.push(
      ghResponse({ message: 'slow down' }, { status: 429, headers: { 'Retry-After': '30' } }),
    );
    const res = await githubApiFetch('/repos/o/r/pulls', TOKEN);
    expect(res.status).toBe(429);

    // A subsequent call during cooldown is synthesized locally, not fetched.
    const res2 = await githubApiFetch('/repos/o/r/pulls', TOKEN);
    expect(res2.status).toBe(429);
    expect(Number(res2.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(githubCalls()).toHaveLength(1);
  });

  test('never caches non-GET requests', async () => {
    ghQueue.push(ghResponse({ merged: true }));
    ghQueue.push(ghResponse({ merged: true }));
    await githubApiFetch('/repos/o/r/pulls/1/merge', TOKEN, { method: 'PUT' });
    await githubApiFetch('/repos/o/r/pulls/1/merge', TOKEN, { method: 'PUT' });
    expect(githubCalls()).toHaveLength(2);
  });

  test('scopes cache per token so bodies never leak across users', async () => {
    ghQueue.push(ghResponse([{ number: 1 }], { etag: 'W/"a"' }));
    await githubApiFetch('/repos/o/r/pulls', TOKEN);

    // Different token, same path — must hit the network, not the other user's cache.
    ghQueue.push(ghResponse([{ number: 99 }], { etag: 'W/"b"' }));
    const other = await githubApiFetch('/repos/o/r/pulls', 'gho_other_user');
    expect(githubCalls()).toHaveLength(2);
    expect(await other.json()).toEqual([{ number: 99 }]);
  });
});
