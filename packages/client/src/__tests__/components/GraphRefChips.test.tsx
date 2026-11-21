import { describe, expect, test, vi } from 'bun:test';

/**
 * GraphRefChips — a branch whose PR is merged reads as merged, not as pending
 * work (after a squash merge its lane never joins the base branch).
 */
import { fireEvent, screen } from '@testing-library/react';

import { GraphRefChips } from '@/components/commit-graph/GraphRefChips';
import { findThreadBranchRowIndex } from '@/components/CommitGraphTab';
import type { FoldedRef } from '@/lib/graph-refs';

import { renderWithProviders } from '../helpers/render';

function renderChips(ref: FoldedRef) {
  renderWithProviders(
    <GraphRefChips
      refs={[ref]}
      branchSummaryByName={new Map()}
      actionInProgress={null}
      color="#a5b4fc"
      searchQuery=""
      onPushBranch={vi.fn()}
      onPullCurrentBranch={vi.fn()}
    />,
  );
  return screen.getByTestId(`graph-ref-chip-${ref.kind}:${ref.name}`);
}

const pr = (state: 'OPEN' | 'MERGED') => ({
  number: 141,
  url: 'https://github.com/o/r/pull/141',
  state,
});

describe('GraphRefChips', () => {
  test('a branch with a merged PR is dimmed and says its code is already in the base branch', () => {
    const chip = renderChips({
      kind: 'remote',
      name: 'origin/feat/rewind',
      isCurrent: false,
      pullRequest: pr('MERGED'),
    });

    expect(chip).toHaveAttribute('data-merged', 'true');
    expect(chip).toHaveClass('opacity-60');
    expect(screen.getByTestId('graph-branch-info-origin/feat/rewind')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('PR #141 merged — its code is already in the base branch'),
    );
  });

  test('a branch with an open PR keeps its normal look', () => {
    const chip = renderChips({
      kind: 'local',
      name: 'feat/wip',
      isCurrent: false,
      pullRequest: pr('OPEN'),
    });

    expect(chip).not.toHaveAttribute('data-merged');
    expect(chip).not.toHaveClass('opacity-60');
    fireEvent.pointerMove(chip);
    expect(screen.getByTestId('graph-branch-info-feat/wip')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('PR #141 (OPEN)'),
    );
  });

  test('points an arrow at the branch the open thread works on', () => {
    renderWithProviders(
      <GraphRefChips
        refs={[
          { kind: 'local', name: 'master', isCurrent: false },
          {
            kind: 'local',
            name: 'funny/fix-issues',
            isCurrent: false,
            syncedRemote: 'origin/funny/fix-issues',
          },
          { kind: 'remote', name: 'origin/master', isCurrent: false },
        ]}
        branchSummaryByName={new Map()}
        actionInProgress={null}
        color="#a5b4fc"
        searchQuery=""
        threadBranch="funny/fix-issues"
        onPushBranch={vi.fn()}
        onPullCurrentBranch={vi.fn()}
      />,
    );

    expect(screen.getAllByTestId('graph-thread-branch-marker')).toHaveLength(1);
    expect(screen.getByTestId('graph-thread-branch-marker')).toHaveAttribute(
      'aria-label',
      'This thread works on funny/fix-issues',
    );
    expect(screen.getByTestId('graph-ref-chip-local:funny/fix-issues')).toHaveAttribute(
      'data-thread-branch',
      'true',
    );
    expect(screen.getByTestId('graph-ref-chip-local:master')).not.toHaveAttribute(
      'data-thread-branch',
    );
  });

  test('shows no arrow without an open thread branch', () => {
    renderChips({ kind: 'local', name: 'master', isCurrent: true });
    expect(screen.queryByTestId('graph-thread-branch-marker')).toBeNull();
  });
});

describe('findThreadBranchRowIndex', () => {
  const entry = (refs: string[]) => ({
    refs: refs.map((name) => ({
      name,
      kind: name.startsWith('origin/') ? ('remote' as const) : ('local' as const),
    })),
    headBranch: null,
  });

  test('finds the row carrying the thread branch tip, ignoring a same-named remote ref', () => {
    const entries = [
      entry(['master']),
      entry(['origin/funny/fix']),
      entry([]),
      entry(['funny/fix']),
    ];
    expect(findThreadBranchRowIndex(entries, 'funny/fix')).toBe(3);
    expect(findThreadBranchRowIndex(entries, 'missing')).toBe(-1);
    expect(findThreadBranchRowIndex(entries, null)).toBe(-1);
  });
});
