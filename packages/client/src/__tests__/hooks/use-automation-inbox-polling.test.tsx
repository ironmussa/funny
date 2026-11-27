import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { act, renderHook } from '@testing-library/react';
import { ResultAsync } from 'neverthrow';

const mockLoadInbox = (() => vi.fn())();

mock.module('@/stores/auth-store', () => ({
  useAuthStore: (selector: (state: { isAuthenticated: boolean }) => unknown) =>
    selector({ isAuthenticated: true }),
}));

mock.module('@/data/automations/loaders', () => ({ loadInbox: mockLoadInbox }));

import { useAutomationInboxPolling } from '@/hooks/use-automation-inbox-polling';

describe('useAutomationInboxPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockLoadInbox.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('does not schedule another poll when an in-flight request resolves after unmount', async () => {
    let resolveLoad!: () => void;
    const load = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    mockLoadInbox.mockReturnValue(ResultAsync.fromSafePromise(load));

    const { unmount } = renderHook(() => useAutomationInboxPolling());
    expect(mockLoadInbox).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      resolveLoad();
      await load;
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});
