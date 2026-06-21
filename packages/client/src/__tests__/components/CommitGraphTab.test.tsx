import { screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { GraphCommitSyncMarkers, GraphCommitTime } from '@/components/CommitGraphTab';
import { inferUnpulledHashesFromGraphEntries } from '@/lib/graph-refs';
import {
  indexRebaseEventsByHash,
  inferRebaseCopyLinks,
  rebaseEventScopeLabel,
} from '@/lib/rebase-events';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallbackOrOpts?: string | Record<string, any>) =>
      typeof fallbackOrOpts === 'string' ? fallbackOrOpts : fallbackOrOpts?.defaultValue || _key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('GraphCommitTime', () => {
  test('shows the short commit date without sync markers', () => {
    renderWithProviders(<GraphCommitTime relativeDate="13 minutes ago" />);

    expect(screen.getByText('13m')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-unpushed-1111111')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graph-unpulled-1111111')).not.toBeInTheDocument();
  });
});

describe('GraphCommitSyncMarkers', () => {
  test('shows an unpushed arrow for local-only commits', () => {
    renderWithProviders(<GraphCommitSyncMarkers unpushed shortHash="1111111" />);

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

  test('does not render when the commit has no sync markers', () => {
    const { container } = renderWithProviders(
      <GraphCommitSyncMarkers unpushed={false} shortHash="1111111" />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('graph-unpushed-1111111')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graph-unpulled-1111111')).not.toBeInTheDocument();
  });

  test('shows an unpulled arrow for remote-only commits', () => {
    renderWithProviders(<GraphCommitSyncMarkers unpushed={false} unpulled shortHash="2222222" />);

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

describe('indexRebaseEventsByHash', () => {
  test('indexes replayed, start, and finish commits for graph decoration', () => {
    const indexed = indexRebaseEventsByHash([
      {
        id: 'rebase-1',
        kind: 'rebase',
        label: 'rebase',
        branch: 'feature',
        onto: 'main',
        startedAt: '2026-06-20T19:51:20-06:00',
        finishedAt: '2026-06-20T20:17:55-06:00',
        startHash: 'base-hash',
        startShortHash: 'base',
        finishHash: 'tip-hash',
        finishShortHash: 'tip',
        completed: true,
        steps: [],
        commitHashes: ['replayed-one', 'tip-hash'],
        commitPairs: [
          {
            originalHash: 'original-one',
            originalShortHash: 'orig1',
            rebasedHash: 'replayed-one',
            rebasedShortHash: 'new1',
            subject: 'feature one',
          },
        ],
      },
    ]);

    expect(indexed.get('base-hash')?.[0].id).toBe('rebase-1');
    expect(indexed.get('original-one')?.[0].id).toBe('rebase-1');
    expect(indexed.get('replayed-one')?.[0].id).toBe('rebase-1');
    expect(indexed.get('tip-hash')?.[0].id).toBe('rebase-1');
    expect(indexed.has('unrelated')).toBe(false);
  });
});

describe('inferRebaseCopyLinks', () => {
  test('uses server-provided original to replayed commit pairs', () => {
    const event = {
      id: 'rebase-1',
      kind: 'rebase' as const,
      label: 'rebase',
      branch: 'feature',
      onto: 'main',
      startedAt: '2026-06-20T19:51:20-06:00',
      finishedAt: '2026-06-20T20:17:55-06:00',
      startHash: 'base-hash',
      startShortHash: 'base',
      finishHash: 'new-three',
      finishShortHash: 'new3',
      completed: true,
      steps: [
        {
          hash: 'new-one',
          shortHash: 'new1',
          selector: 'HEAD@{1}',
          timestamp: '2026-06-20T20:00:00-06:00',
          action: 'pick' as const,
          message: 'feature one',
          subject: 'rebase (pick): feature one',
        },
        {
          hash: 'new-two',
          shortHash: 'new2',
          selector: 'HEAD@{2}',
          timestamp: '2026-06-20T20:01:00-06:00',
          action: 'pick' as const,
          message: 'feature two',
          subject: 'rebase (pick): feature two',
        },
      ],
      commitHashes: ['new-one', 'new-two', 'new-three'],
      commitPairs: [
        {
          originalHash: 'old-one',
          originalShortHash: 'old1',
          rebasedHash: 'new-one',
          rebasedShortHash: 'new1',
          subject: 'feature one',
        },
        {
          originalHash: 'old-two',
          originalShortHash: 'old2',
          rebasedHash: 'new-two',
          rebasedShortHash: 'new2',
          subject: 'feature two',
        },
      ],
    };

    const links = inferRebaseCopyLinks(
      [event],
      [
        { hash: 'new-two' },
        { hash: 'new-one' },
        { hash: 'base-hash' },
        { hash: 'old-two' },
        { hash: 'old-one' },
      ],
    );

    expect(
      links.map((link) => [
        link.sourceHash,
        link.sourceShortHash,
        link.targetHash,
        link.targetShortHash,
        link.subject,
      ]),
    ).toEqual([
      ['old-one', 'old1', 'new-one', 'new1', 'feature one'],
      ['old-two', 'old2', 'new-two', 'new2', 'feature two'],
    ]);
  });

  test('drops links unless both original and rebased commits are visible', () => {
    const event = {
      id: 'rebase-1',
      kind: 'rebase' as const,
      label: 'rebase',
      branch: 'master',
      onto: 'origin/master',
      startedAt: '2026-06-20T19:51:20-06:00',
      finishedAt: '2026-06-20T20:17:55-06:00',
      startHash: 'base-hash',
      startShortHash: 'base',
      finishHash: 'new-one',
      finishShortHash: 'new1',
      completed: true,
      steps: [],
      commitHashes: ['new-one'],
      commitPairs: [
        {
          originalHash: 'old-one',
          originalShortHash: 'old1',
          rebasedHash: 'new-one',
          rebasedShortHash: 'new1',
          subject: 'feature one',
        },
      ],
    };

    const missingOriginal = inferRebaseCopyLinks(
      [event],
      [{ hash: 'new-one' }, { hash: 'base-hash' }],
    );
    const missingTarget = inferRebaseCopyLinks(
      [event],
      [{ hash: 'old-one' }, { hash: 'base-hash' }],
    );

    expect(missingOriginal).toEqual([]);
    expect(missingTarget).toEqual([]);
  });
});

describe('rebaseEventScopeLabel', () => {
  test('shows the branch and target when Git recorded both sides of the rebase', () => {
    expect(rebaseEventScopeLabel({ branch: 'feature/auth', onto: 'main' })).toBe(
      'feature/auth -> main',
    );
  });

  test('falls back to the available side when reflog data is partial', () => {
    expect(rebaseEventScopeLabel({ branch: 'feature/auth', onto: null })).toBe('feature/auth');
    expect(rebaseEventScopeLabel({ branch: null, onto: 'main' })).toBe('onto main');
    expect(rebaseEventScopeLabel({ branch: null, onto: null })).toBeNull();
  });
});
