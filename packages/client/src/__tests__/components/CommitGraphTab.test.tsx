import { screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { GraphCommitTime } from '@/components/CommitGraphTab';
import { inferUnpulledHashesFromGraphEntries } from '@/lib/graph-refs';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallbackOrOpts?: string | Record<string, any>) =>
      typeof fallbackOrOpts === 'string' ? fallbackOrOpts : fallbackOrOpts?.defaultValue || _key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('GraphCommitTime', () => {
  test('shows an unpushed arrow next to the commit date for local-only commits', () => {
    renderWithProviders(
      <GraphCommitTime relativeDate="13 minutes ago" unpushed shortHash="1111111" />,
    );

    expect(screen.getByText('13m')).toBeInTheDocument();
    expect(screen.getByTestId('graph-unpushed-1111111')).toBeInTheDocument();
    expect(screen.getByTestId('graph-unpushed-icon-1111111')).toHaveClass('lucide-circle-arrow-up');
    expect(screen.getByTestId('graph-unpushed-icon-1111111')).toHaveClass('icon-sm');
    expect(screen.getByTestId('graph-unpushed-icon-1111111')).toHaveClass(
      '[&_circle]:fill-current',
    );
    expect(screen.getByTestId('graph-unpushed-icon-1111111')).toHaveClass(
      '[&_path]:stroke-primary-foreground',
    );
  });

  test('does not show an unpushed arrow for remote commits', () => {
    renderWithProviders(
      <GraphCommitTime relativeDate="13 minutes ago" unpushed={false} shortHash="1111111" />,
    );

    expect(screen.getByText('13m')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-unpushed-1111111')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graph-unpulled-1111111')).not.toBeInTheDocument();
  });

  test('shows an unpulled arrow next to the commit date for remote-only commits', () => {
    renderWithProviders(
      <GraphCommitTime
        relativeDate="13 minutes ago"
        unpushed={false}
        unpulled
        shortHash="2222222"
      />,
    );

    expect(screen.getByText('13m')).toBeInTheDocument();
    expect(screen.getByTestId('graph-unpulled-2222222')).toBeInTheDocument();
    expect(screen.getByTestId('graph-unpulled-icon-2222222')).toHaveClass(
      'lucide-circle-arrow-down',
    );
    expect(screen.getByTestId('graph-unpulled-icon-2222222')).toHaveClass('icon-sm');
    expect(screen.queryByTestId('graph-unpushed-2222222')).not.toBeInTheDocument();
  });
});

describe('inferUnpulledHashesFromGraphEntries', () => {
  test('marks commits reachable from remote refs but not local refs', () => {
    const inferred = inferUnpulledHashesFromGraphEntries([
      {
        hash: 'remote-tip',
        parentHashes: ['remote-parent'],
        refs: [{ name: 'origin/feature', kind: 'remote' }],
      },
      {
        hash: 'remote-parent',
        parentHashes: ['shared-base'],
        refs: [],
      },
      {
        hash: 'shared-base',
        parentHashes: [],
        refs: [{ name: 'main', kind: 'local' }],
      },
    ]);

    expect([...inferred]).toEqual(['remote-tip', 'remote-parent']);
  });

  test('does not mark commits when local and remote refs point at the same tip', () => {
    const inferred = inferUnpulledHashesFromGraphEntries([
      {
        hash: 'synced-tip',
        parentHashes: ['base'],
        refs: [
          { name: 'main', kind: 'local' },
          { name: 'origin/main', kind: 'remote' },
        ],
      },
      {
        hash: 'base',
        parentHashes: [],
        refs: [],
      },
    ]);

    expect([...inferred]).toEqual([]);
  });
});
