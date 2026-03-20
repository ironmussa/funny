import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { waitForChrome } from '@funny/core/chrome';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('waitForChrome', () => {
  it('returns immediately when the Chrome version endpoint is ready', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ Browser: 'Chrome' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    await expect(waitForChrome('127.0.0.1', 9222, 50)).resolves.toBeUndefined();
  });

  it('times out immediately when timeout is zero and Chrome is unavailable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('not ready');
    }) as typeof fetch;

    await expect(waitForChrome('127.0.0.1', 9222, 0)).rejects.toThrow(
      '[waitForChrome] Timeout: Chrome not ready after 0ms',
    );
  });
});
