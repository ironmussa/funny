import { describe, expect, it } from 'vitest';

import { getLoadedSidebarResyncTargets, shouldResyncThreadsOnConnect } from '@/hooks/use-ws';

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

describe('getLoadedSidebarResyncTargets', () => {
  it('selects only loaded sidebar buckets that still contain active threads', () => {
    const state = {
      threadIdsByProject: {
        p1: ['running-project-thread', 'completed-project-thread'],
        p2: ['completed-other-project-thread'],
      },
      scratchThreadIds: ['waiting-scratch-thread'],
      sharedThreadIds: ['completed-shared-thread'],
      threadsById: {
        'running-project-thread': { status: 'running' },
        'completed-project-thread': { status: 'completed' },
        'completed-other-project-thread': { status: 'completed' },
        'waiting-scratch-thread': { status: 'waiting' },
        'completed-shared-thread': { status: 'completed' },
      },
    };

    expect(getLoadedSidebarResyncTargets(state as any)).toEqual({
      projectIds: ['p1'],
      scratch: true,
      shared: false,
    });
  });
});
