import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CommitListPanel } from '@/components/commit-history/CommitListPanel';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallbackOrOpts?: string | Record<string, any>) =>
      typeof fallbackOrOpts === 'string' ? fallbackOrOpts : fallbackOrOpts?.defaultValue || _key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const virtualizerState = vi.hoisted(() => ({
  rows: [] as { index: number; start: number }[],
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => virtualizerState.rows,
    getTotalSize: () => 0,
    measureElement: () => {},
  }),
}));

const entries = [
  {
    hash: '1111111111111111111111111111111111111111',
    shortHash: '1111111',
    author: 'Argenis Leon',
    authorEmail: 'argenis@example.com',
    relativeDate: '1 hour ago',
    message: 'feat: current page',
    body: '',
  },
];

describe('CommitListPanel', () => {
  beforeEach(() => {
    virtualizerState.rows = [];
  });

  test('pages ahead while searching so SHA matches can be found beyond the loaded page', async () => {
    const onLoadMore = vi.fn();

    renderWithProviders(
      <CommitListPanel
        logEntries={entries}
        logLoading={false}
        hasMore
        unpushedHashes={new Set()}
        githubAvatarBySha={new Map()}
        githubBrowseBaseUrl={null}
        selectedHash={null}
        onSelectHash={vi.fn()}
        onLoadMore={onLoadMore}
      />,
    );

    expect(onLoadMore).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('history-commit-search-input'), {
      target: { value: '8a7c42d9fb3b544d6ddac03bbdd9a65536f6c05a' },
    });

    await waitFor(() => {
      expect(onLoadMore).toHaveBeenCalledTimes(1);
    });
  });

  test('shows GitHub link for pushed commits', () => {
    virtualizerState.rows = [{ index: 0, start: 0 }];

    renderWithProviders(
      <CommitListPanel
        logEntries={entries}
        logLoading={false}
        hasMore={false}
        unpushedHashes={new Set()}
        githubAvatarBySha={new Map()}
        githubBrowseBaseUrl="https://github.com/acme/funny"
        selectedHash={null}
        onSelectHash={vi.fn()}
        onLoadMore={vi.fn()}
      />,
    );

    expect(screen.getByTestId('history-commit-github-1111111')).toHaveAttribute(
      'href',
      'https://github.com/acme/funny/commit/1111111111111111111111111111111111111111',
    );
  });

  test('hides GitHub link for local-only commits', () => {
    virtualizerState.rows = [{ index: 0, start: 0 }];

    renderWithProviders(
      <CommitListPanel
        logEntries={entries}
        logLoading={false}
        hasMore={false}
        unpushedHashes={new Set([entries[0].hash])}
        githubAvatarBySha={new Map()}
        githubBrowseBaseUrl="https://github.com/acme/funny"
        selectedHash={null}
        onSelectHash={vi.fn()}
        onLoadMore={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('history-commit-github-1111111')).not.toBeInTheDocument();
  });
});
