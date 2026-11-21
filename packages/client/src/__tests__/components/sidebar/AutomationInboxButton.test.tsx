import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { act, render } from '@testing-library/react';
import { ResultAsync } from 'neverthrow';

const mockLoadInbox = (() => vi.fn())();

mock.module('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

mock.module('@/components/ui/nav-item', () => ({
  NavItem: () => null,
}));

mock.module('@/stores/auth-store', () => ({
  useAuthStore: (selector: (state: { isAuthenticated: boolean }) => unknown) =>
    selector({ isAuthenticated: true }),
}));

mock.module('@/data/automations/hooks', () => ({
  useAutomationInbox: () => ({ inbox: [], pendingCount: 0 }),
}));
mock.module('@/data/automations/loaders', () => ({ loadInbox: mockLoadInbox }));

mock.module('@/stores/ui-store', () => ({
  useUIStore: (selector: (state: { automationInboxOpen: boolean }) => unknown) =>
    selector({ automationInboxOpen: false }),
}));

import { AutomationInboxButton } from '@/components/sidebar/AutomationInboxButton';

describe('AutomationInboxButton', () => {
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

    const { unmount } = render(<AutomationInboxButton />);
    expect(mockLoadInbox).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      resolveLoad();
      await load;
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});
