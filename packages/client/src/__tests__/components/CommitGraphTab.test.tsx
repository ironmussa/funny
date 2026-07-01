import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { GraphRefChips } from '@/components/commit-graph/GraphRefChips';
import {
  GraphCommitSyncMarkers,
  GraphCommitTime,
  GraphGutterHorizontalScroller,
  GraphWipRow,
} from '@/components/CommitGraphTab';
import {
  graphGutterViewportWidth,
  graphRefLeaderLineXRange,
  renderedGraphLaneCount,
} from '@/lib/commit-graph-layout';
import {
  inferUnpulledHashesFromGraphEntries,
  type FoldedRef,
  type GraphBranchSummary,
} from '@/lib/graph-refs';
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

describe('renderedGraphLaneCount', () => {
  test('reserves every computed lane instead of capping the graph gutter', () => {
    expect(renderedGraphLaneCount(18)).toBe(18);
    expect(renderedGraphLaneCount(0)).toBe(1);
  });
});

describe('graphGutterViewportWidth', () => {
  test('keeps wide branch graphs from consuming the commit text column', () => {
    expect(graphGutterViewportWidth(544, 780)).toBe(320);
    expect(graphGutterViewportWidth(160, 780)).toBe(160);
    expect(graphGutterViewportWidth(544, 220)).toBe(92);
    expect(graphGutterViewportWidth(544, 0)).toBe(544);
  });
});

describe('GraphGutterHorizontalScroller', () => {
  test('renders a native bottom scrollbar for wide branch graphs', () => {
    const onScrollLeftChange = vi.fn();
    renderWithProviders(
      <GraphGutterHorizontalScroller
        graphViewportWidth={120}
        gutterWidth={320}
        onScrollLeftChange={onScrollLeftChange}
      />,
    );

    expect(screen.queryByTestId('graph-gutter-horizontal-range')).not.toBeInTheDocument();

    const frame = screen.getByTestId('graph-gutter-horizontal-scroll');
    const scrollbar = screen.getByTestId('graph-gutter-horizontal-scrollbar');
    expect(frame).toHaveClass('border-t');
    expect(scrollbar).toHaveClass('scrollbar-visible', 'overflow-x-auto');
    expect(scrollbar).toHaveStyle({ width: '120px', height: '10px' });

    Object.defineProperty(scrollbar, 'scrollLeft', { configurable: true, value: 64 });
    fireEvent.scroll(scrollbar);
    expect(onScrollLeftChange).toHaveBeenCalledWith(64);
  });
});

describe('graphRefLeaderLineXRange', () => {
  test('keeps the visible connector when the branch node scrolls off the left edge', () => {
    expect(
      graphRefLeaderLineXRange({
        nodeX: -24,
        avatarR: 8,
        graphViewportWidth: 120,
        chipLeftX: 144,
      }),
    ).toEqual({ x1: 12, x2: 144 });
  });

  test('omits the connector when the branch node is still off the right edge', () => {
    expect(
      graphRefLeaderLineXRange({
        nodeX: 160,
        avatarR: 8,
        graphViewportWidth: 120,
        chipLeftX: 144,
      }),
    ).toBeNull();
  });
});

describe('GraphWipRow', () => {
  test('does not draw a separator before the first commit row', () => {
    renderWithProviders(
      <GraphWipRow
        status={{
          state: 'dirty',
          linesAdded: 2,
          linesDeleted: 0,
          dirtyFileCount: 1,
          unpushedCommitCount: 0,
          unpulledCommitCount: 0,
          hasRemoteBranch: true,
          isMergedIntoBase: false,
        }}
        firstRow={{ commitLane: 0, nodeColor: 0, segments: [] }}
        laneCount={1}
        gutterWidth={16}
        rowHeight={48}
      />,
    );

    expect(screen.getByTestId('graph-wip-row')).not.toHaveClass('border-b');
  });
});

describe('GraphRefChips', () => {
  test('shows push status, action, and details on a local branch chip that is ahead', async () => {
    const onPushBranch = vi.fn();
    const onPullCurrentBranch = vi.fn();
    const refs: FoldedRef[] = [{ kind: 'local', name: 'feat/video', isCurrent: true }];
    const branch: GraphBranchSummary = {
      branch: 'feat/video',
      localRef: 'feat/video',
      remoteRef: 'origin/feat/video',
      localHash: 'local-tip',
      remoteHash: 'remote-tip',
      isCurrent: true,
      ahead: 2,
      behind: 0,
      state: 'ahead',
      primaryAction: 'push',
    };

    renderWithProviders(
      <GraphRefChips
        refs={refs}
        branchSummaryByName={new Map([[branch.branch, branch]])}
        actionInProgress={null}
        color="#7cb9e8"
        searchQuery=""
        onPushBranch={onPushBranch}
        onPullCurrentBranch={onPullCurrentBranch}
      />,
    );

    expect(screen.getByTestId('graph-branch-status-feat/video')).toHaveTextContent('2');
    expect(screen.getByTestId('graph-branch-status-feat/video')).not.toHaveTextContent('Push');
    expect(screen.getByTestId('graph-branch-status-feat/video')).not.toHaveTextContent('↑');
    expect(screen.getByTestId('graph-ref-chip-local:feat/video')).toHaveClass(
      'hover:brightness-90',
    );
    expect(screen.getByTestId('graph-branch-info-feat/video').className).not.toContain(
      'hover:bg-background/20',
    );
    expect(screen.getByTestId('graph-ref-chip-local:feat/video')).not.toContainElement(
      screen.getByTestId('graph-branch-action-feat/video'),
    );
    expect(screen.getByTestId('graph-ref-chip-local:feat/video')).not.toContainElement(
      screen.getByTestId('graph-branch-status-feat/video'),
    );
    expect(screen.getByTestId('graph-branch-action-feat/video')).toContainElement(
      screen.getByTestId('graph-branch-status-feat/video'),
    );
    expect(screen.getByTestId('graph-branch-action-feat/video')).toHaveClass('bg-primary');
    expect(screen.getByTestId('graph-branch-action-feat/video')).toHaveClass(
      'text-primary-foreground',
    );
    expect(screen.getByTestId('graph-branch-action-feat/video')).toHaveClass('px-1.5');
    expect(screen.getByTestId('graph-branch-action-feat/video').className).not.toContain(
      'bg-sky-950',
    );

    fireEvent.click(screen.getByTestId('graph-branch-info-feat/video'));

    expect(await screen.findByTestId('graph-branch-detail-feat/video')).toHaveTextContent(
      'feat/video',
    );
    expect(screen.getByTestId('graph-branch-detail-feat/video')).toHaveTextContent(
      'origin/feat/video',
    );
    expect(screen.getByTestId('graph-branch-detail-feat/video')).toHaveTextContent('Ahead 2');
    expect(screen.getByTestId('graph-branch-action-icon-feat/video')).toHaveClass('lucide-upload');

    fireEvent.click(screen.getByTestId('graph-branch-action-feat/video'));

    expect(onPushBranch).toHaveBeenCalledWith('feat/video');
    expect(onPullCurrentBranch).not.toHaveBeenCalled();
  });

  test('shows pull status, action, and details on the remote chip for the current behind branch', async () => {
    const onPushBranch = vi.fn();
    const onPullCurrentBranch = vi.fn();
    const refs: FoldedRef[] = [{ kind: 'remote', name: 'origin/main', isCurrent: false }];
    const branch: GraphBranchSummary = {
      branch: 'main',
      localRef: 'main',
      remoteRef: 'origin/main',
      localHash: 'local-tip',
      remoteHash: 'remote-tip',
      isCurrent: true,
      ahead: 0,
      behind: 3,
      state: 'behind',
      primaryAction: 'pull',
    };

    renderWithProviders(
      <GraphRefChips
        refs={refs}
        branchSummaryByName={new Map([[branch.branch, branch]])}
        actionInProgress={null}
        color="#7cb9e8"
        searchQuery=""
        onPushBranch={onPushBranch}
        onPullCurrentBranch={onPullCurrentBranch}
      />,
    );

    expect(screen.getByTestId('graph-branch-info-origin/main')).toHaveTextContent('main');
    expect(screen.getByTestId('graph-branch-info-origin/main')).not.toHaveTextContent(
      'origin/main',
    );
    expect(screen.getByTestId('graph-branch-status-origin/main')).toHaveTextContent('3');
    expect(screen.getByTestId('graph-branch-status-origin/main')).not.toHaveTextContent('Pull');
    expect(screen.getByTestId('graph-branch-status-origin/main')).not.toHaveTextContent('↓');
    expect(screen.getByTestId('graph-branch-action-main')).toHaveClass('bg-primary');
    expect(screen.getByTestId('graph-branch-action-main')).toHaveClass('text-primary-foreground');
    expect(screen.getByTestId('graph-branch-action-main')).toHaveClass('px-1.5');
    expect(screen.getByTestId('graph-branch-action-main').className).not.toContain('bg-amber-950');

    fireEvent.click(screen.getByTestId('graph-branch-info-origin/main'));

    expect(await screen.findByTestId('graph-branch-detail-origin/main')).toHaveTextContent(
      'origin/main',
    );
    expect(screen.getByTestId('graph-branch-detail-origin/main')).toHaveTextContent('Behind 3');
    expect(screen.getByTestId('graph-branch-action-icon-main')).toHaveClass('lucide-download');

    fireEvent.click(screen.getByTestId('graph-branch-action-main'));

    expect(onPullCurrentBranch).toHaveBeenCalledWith('main');
    expect(onPushBranch).not.toHaveBeenCalled();
  });

  test('does not show a redundant Origin status on remote-only branch chips', () => {
    const refs: FoldedRef[] = [{ kind: 'remote', name: 'origin/feature', isCurrent: false }];
    const branch: GraphBranchSummary = {
      branch: 'feature',
      remoteRef: 'origin/feature',
      remoteHash: 'remote-tip',
      isCurrent: false,
      ahead: 0,
      behind: 1,
      state: 'remote-only',
      primaryAction: 'checkout',
    };

    renderWithProviders(
      <GraphRefChips
        refs={refs}
        branchSummaryByName={new Map([[branch.branch, branch]])}
        actionInProgress={null}
        color="#7cb9e8"
        searchQuery=""
        onPushBranch={vi.fn()}
        onPullCurrentBranch={vi.fn()}
      />,
    );

    expect(screen.getByTestId('graph-ref-chip-remote:origin/feature')).toBeInTheDocument();
    expect(screen.getByTestId('graph-branch-info-origin/feature')).toHaveTextContent('feature');
    expect(screen.getByTestId('graph-branch-info-origin/feature')).not.toHaveTextContent(
      'origin/feature',
    );
    expect(screen.queryByTestId('graph-branch-status-origin/feature')).not.toBeInTheDocument();
  });

  test('does not render redundant Local or Synced status chips', () => {
    const refs: FoldedRef[] = [
      { kind: 'local', name: 'main', isCurrent: true, syncedRemote: 'origin/main' },
      { kind: 'local', name: 'draft', isCurrent: false },
    ];
    const syncedBranch: GraphBranchSummary = {
      branch: 'main',
      localRef: 'main',
      remoteRef: 'origin/main',
      localHash: 'main-tip',
      remoteHash: 'main-tip',
      isCurrent: true,
      ahead: 0,
      behind: 0,
      state: 'synced',
      primaryAction: 'none',
    };
    const localBranch: GraphBranchSummary = {
      branch: 'draft',
      localRef: 'draft',
      localHash: 'draft-tip',
      isCurrent: false,
      ahead: 1,
      behind: 0,
      state: 'local-only',
      primaryAction: 'publish',
    };

    renderWithProviders(
      <GraphRefChips
        refs={refs}
        branchSummaryByName={
          new Map([
            [syncedBranch.branch, syncedBranch],
            [localBranch.branch, localBranch],
          ])
        }
        actionInProgress={null}
        color="#7cb9e8"
        searchQuery=""
        onPushBranch={vi.fn()}
        onPullCurrentBranch={vi.fn()}
      />,
    );

    expect(screen.getByTestId('graph-ref-chip-local:main')).toBeInTheDocument();
    expect(screen.getByTestId('graph-ref-chip-local:draft')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-branch-status-main')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graph-branch-status-draft')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graph-branch-action-main')).not.toBeInTheDocument();
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
