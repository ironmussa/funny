import { act, render } from '@testing-library/react';
import { ResultAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockLoadInbox = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/components/ui/nav-item', () => ({
  NavItem: () => null,
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector: (state: { isAuthenticated: boolean }) => unknown) =>
    selector({ isAuthenticated: true }),
}));

vi.mock('@/data/automations/hooks', () => ({
  useAutomationInbox: () => ({ inbox: [], pendingCount: 0 }),
}));
vi.mock('@/data/automations/loaders', () => ({ loadInbox: mockLoadInbox }));

vi.mock('@/stores/ui-store', () => ({
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
    expect(mockLoadInbox).toHaveBeenCalledOnce();

    unmount();
    await act(async () => {
      resolveLoad();
      await load;
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});
