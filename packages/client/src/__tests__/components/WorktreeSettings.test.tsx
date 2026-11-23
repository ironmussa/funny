import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';

import { mockT } from '../helpers/mock-i18n';

const mockListWorktrees = (() => vi.fn())();
const mockListBranches = (() => vi.fn())();

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

mock.module('@/lib/api', () => ({
  api: { listWorktrees: mockListWorktrees, listBranches: mockListBranches },
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { WorktreeSettings } from '@/components/WorktreeSettings';
import { seedProjects } from '@/data/projects/testing';
import { useProjectStore } from '@/stores/project-store';

const main = { path: '/repo', branch: 'master', commit: 'aaaaaaa', isMain: true };
const feature = {
  path: '/repo/.worktrees/feature-x',
  branch: 'feature-x',
  commit: 'bbbbbbb',
  isMain: false,
};

function renderSettings() {
  return render(
    <TooltipProvider>
      <WorktreeSettings projectId="p1" />
    </TooltipProvider>,
  );
}

describe('WorktreeSettings refresh', () => {
  beforeEach(() => {
    useProjectStore.setState({ selectedProjectId: 'p1' });
    // SAFETY: WorktreeSettings reads only `id` from the project row; the rest of
    // the row is irrelevant to the worktree list under test.
    seedProjects([{ id: 'p1', path: '/repo' } as never]);
    mockListWorktrees.mockReset();
    mockListBranches.mockReset();
    mockListBranches.mockReturnValue(okAsync({ branches: ['master'], defaultBranch: 'master' }));
  });

  test('re-reads the worktrees and branches and shows one created outside funny', async () => {
    mockListWorktrees.mockReturnValueOnce(okAsync([main]));
    renderSettings();
    await waitFor(() => expect(screen.getByText('master')).toBeInTheDocument());
    expect(screen.queryByText('feature-x')).not.toBeInTheDocument();

    mockListWorktrees.mockReturnValueOnce(okAsync([main, feature]));
    fireEvent.click(screen.getByTestId('worktree-settings-refresh'));

    await waitFor(() => expect(screen.getByText('feature-x')).toBeInTheDocument());
    expect(mockListWorktrees).toHaveBeenCalledTimes(2);
    expect(mockListBranches).toHaveBeenCalledTimes(2);
  });

  test('keeps the list on screen while refreshing', async () => {
    mockListWorktrees.mockReturnValueOnce(okAsync([main]));
    renderSettings();
    await waitFor(() => expect(screen.getByText('master')).toBeInTheDocument());

    // A refresh that never answers: the list stays, no full-pane loading state.
    mockListWorktrees.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByTestId('worktree-settings-refresh'));

    expect(screen.getByText('master')).toBeInTheDocument();
    expect(screen.queryByTestId('worktree-settings-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('worktree-settings-refresh')).toBeDisabled();
  });

  test('puts refresh, then create, then the worktree count at the right end', async () => {
    mockListWorktrees.mockReturnValueOnce(okAsync([main, feature]));
    renderSettings();
    await waitFor(() =>
      expect(screen.getByTestId('worktree-settings-count')).toHaveTextContent(
        'review.toolbarCount.worktrees:2',
      ),
    );

    const toolbar = screen.getByTestId('worktree-settings-refresh').parentElement!;
    expect([...toolbar.children].map((el) => el.getAttribute('data-testid'))).toEqual([
      'worktree-settings-refresh',
      'worktree-settings-create',
      'worktree-settings-count',
    ]);
  });
});
