import { describe, expect, it } from 'vitest';

import { shouldResyncThreadsOnConnect } from '@/hooks/use-ws';

/**
 * Regression: opening a heavy thread (megabytes of inline base64 images) showed
 * a visible "double refresh" — the cold-load select fetched the full payload,
 * then the WS `connect` handler refetched it again via refreshAllLoadedThreads,
 * repainting the whole message list. The resync only recovers events missed
 * while disconnected, so it must NOT run on the initial connect.
 */
describe('shouldResyncThreadsOnConnect', () => {
  const threadRoute = '/projects/p1/threads/t1';

  it('does NOT resync on the initial connect (cold load already fetched fresh)', () => {
    expect(shouldResyncThreadsOnConnect(false, threadRoute)).toBe(false);
  });

  it('resyncs on reconnect to recover events missed while disconnected', () => {
    expect(shouldResyncThreadsOnConnect(true, threadRoute)).toBe(true);
  });

  it('never resyncs on routes that do not display thread data, even on reconnect', () => {
    expect(shouldResyncThreadsOnConnect(true, '/settings/profile')).toBe(false);
    expect(shouldResyncThreadsOnConnect(true, '/preferences/appearance')).toBe(false);
    expect(shouldResyncThreadsOnConnect(false, '/settings/profile')).toBe(false);
  });
});
