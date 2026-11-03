import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    ...props
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => onSelect?.()}
      {...props}
    >
      {children}
    </button>
  ),
}));
import { BrowserSessionMenu } from '@/components/browser-panel/BrowserSessionMenu';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

describe('BrowserSessionMenu', () => {
  const endBrowserSession = vi.fn(async () => {});
  const clearBrowserProfile = vi.fn(async () => {});

  beforeEach(() => {
    endBrowserSession.mockClear();
    clearBrowserProfile.mockClear();
    useBrowserPanelStore.setState({
      sessionId: null,
      sessionThreadId: null,
      endBrowserSession,
      clearBrowserProfile,
    });
  });

  test('closing is disabled without a session', () => {
    render(<BrowserSessionMenu />);
    expect(screen.getByTestId('browser-panel-close-session')).toBeDisabled();
  });

  test('closes the current session', () => {
    useBrowserPanelStore.setState({ sessionId: 'thread:t1', sessionThreadId: 't1' });
    render(<BrowserSessionMenu />);
    fireEvent.click(screen.getByTestId('browser-panel-close-session'));
    expect(endBrowserSession).toHaveBeenCalled();
  });

  test('clearing the profile asks for confirmation first', () => {
    render(<BrowserSessionMenu />);
    fireEvent.click(screen.getByTestId('browser-panel-clear-profile'));
    expect(clearBrowserProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('browser-panel-clear-profile-confirm'));
    expect(clearBrowserProfile).toHaveBeenCalled();
  });
});
