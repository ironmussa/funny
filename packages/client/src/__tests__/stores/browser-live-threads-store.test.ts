import { errAsync, okAsync } from 'neverthrow';
import { afterEach, describe, expect, test, vi } from 'vitest';

const liveThreads = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/browser-sessions', () => ({ browserSessionsApi: { liveThreads } }));

import {
  loadLiveBrowserThreads,
  useBrowserLiveThreadsStore,
} from '@/stores/browser-live-threads-store';

afterEach(() => {
  liveThreads.mockReset();
  useBrowserLiveThreadsStore.setState({ byThread: {} });
});

describe('loadLiveBrowserThreads', () => {
  test("marks the runner's live browser threads after a reload", async () => {
    liveThreads.mockReturnValue(okAsync({ threadIds: ['t1', 't2'] }));
    await loadLiveBrowserThreads();
    expect(useBrowserLiveThreadsStore.getState().byThread).toEqual({ t1: true, t2: true });
  });

  test('drops marks for sessions that closed while disconnected', async () => {
    useBrowserLiveThreadsStore.setState({ byThread: { gone: true } });
    liveThreads.mockReturnValue(okAsync({ threadIds: ['t1'] }));
    await loadLiveBrowserThreads();
    expect(useBrowserLiveThreadsStore.getState().byThread).toEqual({ t1: true });
  });

  test('keeps the current marks when the runner cannot answer', async () => {
    useBrowserLiveThreadsStore.setState({ byThread: { t1: true } });
    liveThreads.mockReturnValue(errAsync({ message: 'runner offline' }));
    await loadLiveBrowserThreads();
    expect(useBrowserLiveThreadsStore.getState().byThread).toEqual({ t1: true });
  });
});
