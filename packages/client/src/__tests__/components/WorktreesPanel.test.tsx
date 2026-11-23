import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { mocked } from '@funny/test-kit';
import { screen, waitFor, within } from '@testing-library/react';
import { okAsync, ResultAsync } from 'neverthrow';

import { WorktreesPanel } from '@/components/review-pane/panels/WorktreesPanel';
import { buildSettingsItems, routableSettingsIds } from '@/components/settings/items';
import { buildProject, withProjects } from '@/data/projects/testing';
import { buildThread, seedProjectThreads } from '@/data/threads/testing';
import { api } from '@/lib/api';
import { useProjectStore } from '@/stores/project-store';

import { flushAsyncUpdates, renderWithProviders } from '../helpers/render';

interface ReviewPaneContextMock {
  remoteCheckProjectId: string | null;
  viewerReadOnly: boolean;
  basePath: string;
}

const context = ((): ReviewPaneContextMock => ({
  remoteCheckProjectId: 'p2',
  viewerReadOnly: false,
  basePath: '/second/feature',
}))();
mock.module('@/components/review-pane/ReviewPaneStateContext', () => ({
  useReviewPaneContext: () => context,
}));
mock.module('@/lib/api', () => ({
  api: { listWorktrees: vi.fn(), listBranches: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  context.remoteCheckProjectId = 'p2';
  context.viewerReadOnly = false;
  context.basePath = '/second/feature';
  useProjectStore.setState(
    withProjects({
      selectedProjectId: 'p1',
      projects: [
        buildProject({ id: 'p1', name: 'First', path: '/first' }),
        buildProject({ id: 'p2', name: 'Second', path: '/second' }),
      ],
    }),
  );
  mocked(api.listWorktrees).mockReturnValue(
    okAsync([
      { path: '/second/feature', branch: 'feature/test', commit: 'abcdef12', isMain: false },
    ]),
  );
  mocked(api.listBranches).mockReturnValue(
    okAsync({
      branches: ['main'],
      remoteBranches: [],
      defaultBranch: 'main',
      currentBranch: null,
    }),
  );
});

describe('Worktrees sidebar', () => {
  test('loads worktrees for the review target instead of the selected project', async () => {
    renderWithProviders(<WorktreesPanel />);
    expect(await screen.findByText('feature/test')).toBeInTheDocument();
    expect(api.listWorktrees).toHaveBeenCalledWith('p2');
    expect(api.listWorktrees).not.toHaveBeenCalledWith('p1');
  });

  test('reloads the list when the review target changes', async () => {
    const view = renderWithProviders(<WorktreesPanel />);
    await screen.findByText('feature/test');
    context.remoteCheckProjectId = 'p1';
    view.rerender(<WorktreesPanel />);
    await waitFor(() => expect(api.listWorktrees).toHaveBeenCalledWith('p1'));
  });

  test('hides mutation actions for read-only viewers', async () => {
    context.viewerReadOnly = true;
    renderWithProviders(<WorktreesPanel />);
    await screen.findByText('feature/test');
    // Refreshing only reads, so it stays; creating and removing worktrees do not.
    const buttons = screen.queryAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('data-testid', 'worktree-settings-refresh');
  });

  test('does not load another project when the review target is absent', () => {
    context.remoteCheckProjectId = null;
    renderWithProviders(<WorktreesPanel />);
    expect(api.listWorktrees).not.toHaveBeenCalled();
  });

  test('uses a full-height centered loading state', async () => {
    mocked(api.listWorktrees).mockReturnValue(
      ResultAsync.fromSafePromise(new Promise<never>(() => {})),
    );
    renderWithProviders(<WorktreesPanel />);
    // Branches load alongside the (never-ending) worktree list.
    await flushAsyncUpdates();
    expect(screen.getByTestId('worktree-settings-loading')).toHaveClass(
      'flex-1',
      'flex-col',
      'items-center',
      'justify-center',
    );
  });

  test('lets the empty message fill the available panel height', async () => {
    mocked(api.listWorktrees).mockReturnValue(okAsync([]));
    renderWithProviders(<WorktreesPanel />);
    expect(await screen.findByTestId('worktree-settings-empty')).toHaveClass(
      'flex-1',
      'items-center',
      'justify-center',
    );
  });

  test('distinguishes the main checkout from the active linked worktree', async () => {
    mocked(api.listWorktrees).mockReturnValue(
      okAsync([
        { path: '/second', branch: 'main', commit: 'abcdef12', isMain: true },
        { path: '/second/feature', branch: 'feature/test', commit: 'abcdef12', isMain: false },
      ]),
    );
    const view = renderWithProviders(<WorktreesPanel />);
    await screen.findByText('feature/test');
    // The original checkout is marked by a house icon on its path, not a chip.
    expect(screen.getAllByTestId('worktree-main-icon')).toHaveLength(1);
    expect(screen.getByTestId('worktree-open-directory-main')).toContainElement(
      screen.getByTestId('worktree-main-icon'),
    );
    expect(screen.queryByTestId('worktree-badge-main')).not.toBeInTheDocument();
    // The active worktree's branch chip is outlined (like History's thread
    // branch) instead of carrying a separate "Current" badge.
    const featureChip = screen.getByTestId('worktree-branch-feature/test');
    expect(featureChip).toHaveAttribute('data-highlighted', 'true');
    expect(featureChip.style.boxShadow).toContain('1.5px');
    expect(featureChip).toHaveTextContent('Current');
    expect(screen.getByTestId('worktree-branch-main')).not.toHaveAttribute('data-highlighted');
    expect(screen.queryByTestId('worktree-badge-active')).not.toBeInTheDocument();
    context.basePath = '/second';
    view.rerender(<WorktreesPanel />);
    expect(screen.getByTestId('worktree-branch-main')).toHaveAttribute('data-highlighted', 'true');
    expect(screen.getByTestId('worktree-branch-feature/test')).not.toHaveAttribute(
      'data-highlighted',
    );
    context.basePath = '';
    view.rerender(<WorktreesPanel />);
    expect(screen.queryByText('Current')).not.toBeInTheDocument();
  });

  test("shows a worktree's thread title the way the sidebar does", async () => {
    seedProjectThreads({
      p2: [
        buildThread({
          id: 't-wt',
          projectId: 'p2',
          title: 'mover comment y share',
          worktreePath: '/second/feature',
        }),
      ],
    });
    renderWithProviders(<WorktreesPanel />);

    const link = await screen.findByTestId('worktree-thread-link-t-wt');
    const title = within(link).getByText('mover comment y share');
    // Same treatment as the sidebar's ThreadTitle: first letter capitalized.
    expect(title).toHaveClass('first-letter:uppercase');
    expect(link).toHaveClass('text-thread-title', 'text-sm');
  });

  test('removes worktrees from project settings', () => {
    const items = buildSettingsItems({ selectedProjectId: 'p1', isProjectAdmin: true });
    expect(items.map((item) => item.id)).not.toContain('worktrees');
    expect(routableSettingsIds.has('worktrees')).toBe(false);
  });
});
