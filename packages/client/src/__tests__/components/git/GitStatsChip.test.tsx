import { describe, expect, test } from 'bun:test';

import type { GitStatusInfo } from '@funny/shared';
import { screen } from '@testing-library/react';

import { GitStatsChip } from '@/components/git/GitStatsChip';

import { renderWithProviders } from '../../helpers/render';

function status(overrides: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    threadId: 't-1',
    branchKey: 'p-1:feat/x',
    state: 'dirty',
    dirtyFileCount: 0,
    unpushedCommitCount: 0,
    unpulledCommitCount: 0,
    hasRemoteBranch: true,
    isMergedIntoBase: false,
    linesAdded: 0,
    linesDeleted: 0,
    ...overrides,
  };
}

function renderChip(gitStatus: GitStatusInfo) {
  return renderWithProviders(
    <GitStatsChip gitStatus={gitStatus} id="t-1" testIdPrefix="card-git" prTestId="card-pr" />,
  );
}

describe('GitStatsChip', () => {
  test('groups the PR, uncommitted files and unpushed commits with separators between', () => {
    renderChip(
      status({ prNumber: 42, prState: 'OPEN', dirtyFileCount: 5, unpushedCommitCount: 3 }),
    );

    const chip = screen.getByTestId('card-git-stats-t-1');
    expect(chip).toContainElement(screen.getByTestId('card-pr'));
    expect(screen.getByTestId('card-git-dirty-t-1')).toHaveTextContent('5');
    expect(screen.getByTestId('card-git-sync-t-1')).toHaveTextContent('3');
    expect(chip.querySelectorAll('[data-orientation="vertical"]')).toHaveLength(2);
  });

  test('keeps the state color on both the icon and the count', () => {
    renderChip(status({ prNumber: 42, prState: 'MERGED', unpushedCommitCount: 3 }));

    const pr = screen.getByTestId('card-pr');
    expect(pr.className).toContain('text-git-icon-merged');

    const sync = screen.getByTestId('card-git-sync-t-1');
    expect(sync.className).toContain('text-git-icon-unpushed');
  });

  test('renders nothing without a PR or pending work', () => {
    renderChip(status({ state: 'clean' }));
    expect(screen.queryByTestId('card-git-stats-t-1')).not.toBeInTheDocument();
  });
});
