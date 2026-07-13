import { fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
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

vi.mock('sonner', () => ({
  toast: { success: vi.fn() },
}));

vi.mock('@/components/ui/dropdown-menu', () => {
  return {
    DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
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

  test('renders referenced file chips without native browser tooltips', () => {
    const content =
      '<referenced-files>\n<file path="src/modules/storyproducer/components/RelayClipPlayer.tsx" />\n</referenced-files>\nUse @src/modules/storyproducer/components/RelayClipPlayer.tsx';

    renderWithProviders(<UserMessageCard content={content} data-testid="msg-file-tooltip" />);

    expect(screen.getByTestId('file-chip')).not.toHaveAttribute('title');
  });

  test('renders leading exclamation commands as command-line chips', () => {
    renderWithProviders(
      <UserMessageCard content={'! bun test --filter auth\nReview output'} data-testid="msg-cmd" />,
    );

    const commandChip = screen.getByTestId('user-message-command-line');
    expect(commandChip).toHaveTextContent('>');
    expect(commandChip).toHaveTextContent('bun test --filter auth');
    expect(commandChip).not.toHaveAttribute('title');
    expect(screen.getByText(/Review output/)).toBeInTheDocument();
  });

  test('does not render inline punctuation exclamation as a command chip', () => {
    renderWithProviders(<UserMessageCard content="Careful! run tests" data-testid="msg-bang" />);

    expect(screen.queryByTestId('user-message-command-line')).not.toBeInTheDocument();
    expect(screen.getByText('Careful! run tests')).toBeInTheDocument();
  });

  test('renders URLs as theme-aware links', () => {
    const url = 'https://example.com/path';
    renderWithProviders(<UserMessageCard content={`Check ${url} please`} data-testid="msg-url" />);

    const link = screen.getByRole('link', { name: url });
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.className).toContain('text-background/70');
    expect(link.className).not.toContain('text-sky');
  });

  test('renders Linear issue URLs as parsed issue badges', () => {
    const url = 'https://linear.app/goliiive-v3/issue/GOL-733/example';
    renderWithProviders(
      <UserMessageCard content={`/fix-linear ${url}`} data-testid="msg-linear-url" />,
    );

    expect(screen.getByTestId('user-message-slash-command')).toHaveTextContent('fix-linear');
    expect(screen.getByTestId('user-message-slash-command')).toHaveClass('h-5');
    expect(screen.getByTestId('user-message-linear-issue')).toHaveTextContent('GOL-733');
    expect(screen.getByTestId('user-message-linear-issue')).toHaveClass('h-5');
    expect(screen.getByTestId('user-message-linear-issue')).toHaveClass('text-background/70');
    expect(screen.queryByRole('link', { name: url })).not.toBeInTheDocument();
  });

  test('renders GitHub pull request URLs as parsed PR badges inline', () => {
    const url = 'https://github.com/goliiive/goliiive-v2/pull/86';
    renderWithProviders(
      <UserMessageCard
        content={`puedes revisar este PR ${url} pero eta contra QA`}
        data-testid="msg-github-pr-url"
      />,
    );

    const prBadge = screen.getByTestId('user-message-github-pr');
    expect(prBadge).toHaveTextContent('#86');
    expect(prBadge).toHaveAttribute('href', url);
    expect(prBadge).toHaveClass('h-5');
    expect(prBadge).toHaveClass('text-background/70');
    expect(screen.queryByRole('link', { name: url })).not.toBeInTheDocument();
    expect(screen.getByText(/puedes revisar este PR/)).toBeInTheDocument();
    expect(screen.getByText(/pero eta contra QA/)).toBeInTheDocument();
  });

  test('renders model and permission badges', () => {
    const timestampIso = new Date().toISOString();

    renderWithProviders(
      <UserMessageCard
        content="hello"
        model="sonnet-4.6"
        permissionMode="autoEdit"
        effort="high"
        timestamp={timestampIso}
        data-testid="msg-4"
      />,
    );

    expect(screen.getByText(/sonnet-4.6/)).toBeInTheDocument();
    expect(screen.getByText('prompt.autoEdit')).toBeInTheDocument();
    expect(screen.getByText(/High/)).toBeInTheDocument();
    const timestamp = screen.getByText('time.now');
    expect(timestamp).toBeInTheDocument();
    expect(timestamp).toHaveClass('thread-timestamp');
    expect(screen.getByTestId('msg-4').className).toContain('grid grid-cols-[minmax(0,1fr)_auto]');
    expect(timestamp.parentElement).toHaveAttribute('data-testid', 'user-message-side-meta');
    expect(timestamp.parentElement?.className).toContain('justify-between');
  });

  test('keeps actions and timestamp in the same right-side column', () => {
    const timestampIso = new Date().toISOString();

    renderWithProviders(
      <UserMessageCard
        content="branch me"
        timestamp={timestampIso}
        onFork={vi.fn()}
        data-testid="msg-actions-layout"
      />,
    );

    const actionsButton = screen.getByTestId('user-message-actions-menu-msg-actions-layout');
    const timestamp = screen.getByText('time.now');
    const sideMeta = screen.getByTestId('user-message-side-meta');

    expect(sideMeta).toContainElement(actionsButton);
    expect(sideMeta).toContainElement(timestamp);
    expect(sideMeta.className).toContain('items-end');
    expect(sideMeta.className).toContain('justify-between');
  });

  test('supports keyboard activation when the card is clickable', () => {
    const onClick = vi.fn();

    renderWithProviders(
      <UserMessageCard content="open me" onClick={onClick} data-testid="msg-keyboard" />,
    );

    const card = screen.getByTestId('msg-keyboard');
    expect(card).toHaveAttribute('role', 'button');
    expect(card).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });

    expect(onClick).toHaveBeenCalledTimes(2);
  });

  test('renders image attachments as clickable buttons', () => {
    const onImageClick = vi.fn();

    renderWithProviders(
      <UserMessageCard
        content="review screenshot"
        images={[{ source: { media_type: 'image/png', data: 'ZmFrZQ==' } }]}
        onImageClick={onImageClick}
        data-testid="msg-image"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Attachment 1' }));

    expect(onImageClick).toHaveBeenCalledWith(
      [{ src: 'data:image/png;base64,ZmFrZQ==', alt: 'Attachment 1' }],
      0,
    );
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

  test('copies the visible message content from the external copy button', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderWithProviders(
      <UserMessageCard
        content={
          '<referenced-files>\n<file path="src/utils.ts" />\n</referenced-files>\nCopy this text'
        }
        onFork={vi.fn()}
        data-testid="msg-copy"
      />,
    );

    const copyButton = screen.getByTestId('user-message-copy-content-msg-copy');

    expect(copyButton).toHaveAttribute('aria-label', 'Copy content');
    expect(copyButton).not.toHaveAttribute('role', 'menuitem');

    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith('Copy this text');
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Copied');
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
