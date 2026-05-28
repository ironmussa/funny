import { fireEvent, screen } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import { UserMessageCard } from '@/components/thread/UserMessageCard';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/components/ui/dropdown-menu', () => {
  const React = require('react');
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    DropdownMenuItem: ({
      children,
      onSelect,
      disabled,
      ...props
    }: {
      children: React.ReactNode;
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
  };
});

describe('UserMessageCard', () => {
  test('renders plain message text', () => {
    renderWithProviders(<UserMessageCard content="Fix the login bug" data-testid="msg-1" />);

    expect(screen.getByTestId('msg-1')).toBeInTheDocument();
    expect(screen.getByText('Fix the login bug')).toBeInTheDocument();
  });

  test('strips referenced-files XML and shows unmentioned attachments as chips', () => {
    const content =
      '<referenced-files>\n<file path="src/utils.ts" />\n</referenced-files>\nReview this';

    renderWithProviders(<UserMessageCard content={content} data-testid="msg-2" />);

    expect(screen.getByText('Review this')).toBeInTheDocument();
    expect(screen.getByTestId('user-message-attached-files')).toBeInTheDocument();
    expect(screen.getByText('utils.ts')).toBeInTheDocument();
  });

  test('renders slash commands and @path mentions inline', () => {
    const content =
      '<referenced-files>\n<file path="src/a.ts" />\n</referenced-files>\nUse @src/a.ts with /review';

    renderWithProviders(<UserMessageCard content={content} data-testid="msg-3" />);

    expect(screen.getByTestId('user-message-slash-command')).toHaveTextContent('review');
    expect(screen.getAllByText('a.ts').length).toBeGreaterThan(0);
  });

  test('renders model and permission badges', () => {
    renderWithProviders(
      <UserMessageCard
        content="hello"
        model="claude-sonnet-4-6"
        permissionMode="autoEdit"
        effort="high"
        timestamp={new Date().toISOString()}
        data-testid="msg-4"
      />,
    );

    expect(screen.getByText(/claude-sonnet-4-6/)).toBeInTheDocument();
    expect(screen.getByText('prompt.autoEdit')).toBeInTheDocument();
    expect(screen.getByText(/High/)).toBeInTheDocument();
    expect(screen.getByText('time.now')).toBeInTheDocument();
  });

  test('invokes fork handler from the actions menu', () => {
    const onFork = vi.fn();

    renderWithProviders(
      <UserMessageCard content="branch me" onFork={onFork} data-testid="msg-5" />,
    );

    fireEvent.click(screen.getByTestId('user-message-actions-menu-msg-5'));
    fireEvent.click(screen.getByTestId('user-message-fork-msg-5'));

    expect(onFork).toHaveBeenCalledTimes(1);
  });

  test('disables rewind actions when rewindDisabled is true', () => {
    renderWithProviders(
      <UserMessageCard
        content="rewind"
        onRewind={vi.fn()}
        rewindDisabled
        rewindDisabledReason="Not supported"
        data-testid="msg-6"
      />,
    );

    fireEvent.click(screen.getByTestId('user-message-actions-menu-msg-6'));

    expect(screen.getByTestId('user-message-rewind-msg-6')).toHaveAttribute('disabled');
  });

  describe('long content collapse', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight',
    );

    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get() {
          return 200;
        },
      });
    });

    afterEach(() => {
      if (originalDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalDescriptor);
      }
    });

    test('shows expand control for overflowing messages', () => {
      renderWithProviders(<UserMessageCard content={'line\n'.repeat(20)} data-testid="msg-7" />);

      expect(screen.getByText('Show more')).toBeInTheDocument();
    });
  });
});
