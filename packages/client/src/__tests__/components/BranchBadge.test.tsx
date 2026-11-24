import { describe, expect, test } from 'bun:test';

/**
 * BranchBadge — a branch has one color everywhere: the badge in the PRs,
 * Worktrees and Stash tabs takes the color the History graph gives the branch.
 */
import { screen } from '@testing-library/react';

import { BranchBadge } from '@/components/BranchBadge';
import { computeGraphRows } from '@/lib/git-graph-lanes';
import { branchColor, graphColorKey, graphLanePastel } from '@/lib/graph-colors';

import { renderWithProviders } from '../helpers/render';

describe('BranchBadge color', () => {
  test('matches the color of the branch tip in the History graph', () => {
    const branch = 'feat/settings-filter';
    // The History graph keys a branch tip's color on the branch name.
    const { rows } = computeGraphRows([{ hash: 'tip', parentHashes: [] }], {
      colorKeyOf: () => graphColorKey(branch),
    });
    const graphColor = graphLanePastel(rows[0].nodeColor);

    expect(branchColor(branch)).toBe(graphColor);

    renderWithProviders(<BranchBadge branch={branch} data-testid="badge" />);
    const badge = screen.getByTestId('badge');
    expect(badge.style.getPropertyValue('--branch-badge-bg')).toBe(graphColor);
    expect(badge).toHaveClass('bg-[color:var(--branch-badge-bg)]');
  });

  test('the same name gets the same color, different names can differ', () => {
    expect(branchColor('master')).toBe(branchColor('master'));
    const colors = new Set(['master', 'develop', 'feat/a', 'feat/b', 'fix/c'].map(branchColor));
    expect(colors.size).toBeGreaterThan(1);
  });

  test('the default branch is the same blue in every repository, and no other branch takes it', () => {
    const blue = graphLanePastel(0);
    expect(branchColor('main')).toBe(blue);
    expect(branchColor('master')).toBe(blue);
    // In the History graph too: the lane of `main` is that blue.
    const { rows } = computeGraphRows([{ hash: 'tip', parentHashes: [] }], {
      colorKeyOf: () => graphColorKey('main'),
    });
    expect(graphLanePastel(rows[0].nodeColor)).toBe(blue);

    const others = Array.from({ length: 200 }, (_, i) => `feat/branch-${i}`);
    expect(others.some((name) => branchColor(name) === blue)).toBe(false);
  });
});
