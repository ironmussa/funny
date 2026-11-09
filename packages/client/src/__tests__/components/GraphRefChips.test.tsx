/**
 * GraphRefChips — a branch whose PR is merged reads as merged, not as pending
 * work (after a squash merge its lane never joins the base branch).
 */
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { GraphRefChips } from '@/components/commit-graph/GraphRefChips';
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
});
