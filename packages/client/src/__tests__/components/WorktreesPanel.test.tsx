import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { mocked } from '@funny/test-kit';
import { screen, waitFor, within } from '@testing-library/react';
import { okAsync, ResultAsync } from 'neverthrow';

import { WorktreesPanel } from '@/components/review-pane/panels/WorktreesPanel';
import { buildSettingsItems, routableSettingsIds } from '@/components/settings/items';
import { seedGitStatus } from '@/data/git-status/testing';
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
  seedGitStatus({ statusByBranch: {}, threadToBranchKey: {} });
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

  test('shows a detached worktree, which has no branch, without crashing', async () => {
    mocked(api.listWorktrees).mockReturnValue(
      okAsync([
        { path: '/second', branch: 'main', commit: 'abcdef12', isMain: true },
        { path: '/tmp/detached', commit: '1234567890abcdef', isMain: false },
      ]),
    );
    renderWithProviders(<WorktreesPanel />);
    const label = await screen.findByTestId('worktree-detached-1234567');
    expect(label).toHaveTextContent('1234567');
    // The path is no longer a row of its own; the open-directory icon carries it.
    expect(screen.getByTestId('worktree-open-directory-1234567')).toBeInTheDocument();
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
    // The original checkout is marked by a house icon beside its branch, not a chip.
    expect(screen.getAllByTestId('worktree-main-icon')).toHaveLength(1);
    expect(screen.getByTestId('worktree-row-main')).toContainElement(
      screen.getByTestId('worktree-main-icon'),
    );
    // It can be opened, but not deleted: its actions hold only the open icon.
    expect(screen.getByTestId('worktree-actions-main')).toContainElement(
      screen.getByTestId('worktree-open-directory-main'),
    );
    expect(screen.queryByTestId('worktree-delete-main')).not.toBeInTheDocument();
    expect(screen.queryByTestId('worktree-badge-main')).not.toBeInTheDocument();
    // The active worktree shows as a selected row (like the sidebar's selected
    // thread), not as an outlined branch chip or a separate "Current" badge.
    const featureRow = screen.getByTestId('worktree-row-feature/test');
    expect(featureRow).toHaveAttribute('data-active', 'true');
    expect(featureRow).toHaveAttribute('aria-current', 'true');
    expect(featureRow.className).toContain('bg-sidebar-selected');
    expect(screen.getByTestId('worktree-branch-feature/test')).not.toHaveAttribute(
      'data-highlighted',
    );
    expect(screen.getByTestId('worktree-row-main')).not.toHaveAttribute('data-active');
    expect(screen.queryByTestId('worktree-badge-active')).not.toBeInTheDocument();
    context.basePath = '/second';
    view.rerender(<WorktreesPanel />);
    expect(screen.getByTestId('worktree-row-main')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('worktree-row-feature/test')).not.toHaveAttribute('data-active');
    context.basePath = '';
    view.rerender(<WorktreesPanel />);
    expect(screen.queryByTestId('worktree-row-main')).not.toHaveAttribute('data-active');
    expect(screen.getByTestId('worktree-row-feature/test')).not.toHaveAttribute('data-active');
  });

  test("draws a worktree's thread with the sidebar's own row", async () => {
    seedProjectThreads({
      p2: [
        buildThread({
          id: 't-wt',
          projectId: 'p2',
          title: 'mover comment y share',
          status: 'stopped',
          branch: 'feature/test',
          worktreePath: '/second/feature',
        }),
      ],
    });
    renderWithProviders(<WorktreesPanel />);

    const item = await screen.findByTestId('thread-item-t-wt');
    expect(screen.getByTestId('worktree-row-feature/test')).toContainElement(item);
    expect(within(item).getByText('mover comment y share')).toBeInTheDocument();
    // The branch is the sidebar's powerline, not a second label of the worktree's.
    expect(within(item).getByTestId('thread-powerline-t-wt')).toBeInTheDocument();
    expect(screen.queryByTestId('worktree-branch-feature/test')).not.toBeInTheDocument();
    // The worktree row keeps its own actions: the thread's menu is hidden.
    expect(screen.queryByTestId('thread-item-more-t-wt')).not.toBeInTheDocument();
  });

  test("shows a worktree's git state with the sidebar's chips", async () => {
    seedProjectThreads({
      p2: [buildThread({ id: 't-wt', projectId: 'p2', worktreePath: '/second/feature' })],
    });
    seedGitStatus({
      threadToBranchKey: { 't-wt': 'bk-feature' },
      statusByBranch: {
        'bk-feature': {
          threadId: 't-wt',
          branchKey: 'bk-feature',
          state: 'dirty',
          dirtyFileCount: 3,
          unpushedCommitCount: 2,
          unpulledCommitCount: 0,
          hasRemoteBranch: true,
          isMergedIntoBase: false,
          linesAdded: 10,
          linesDeleted: 1,
          prNumber: 440,
          prState: 'OPEN',
        },
      },
    });
    renderWithProviders(<WorktreesPanel />);

    expect(await screen.findByTestId('thread-git-dirty-t-wt')).toHaveTextContent('3');
    expect(screen.getByTestId('thread-git-sync-t-wt')).toHaveTextContent('2');
    expect(screen.getByTestId('thread-pr-badge-t-wt')).toHaveTextContent('440');
  });

  test('orders the main checkout, then working threads, then by activity, then worktrees with no thread', async () => {
    mocked(api.listWorktrees).mockReturnValue(
      okAsync([
        { path: '/second/orphan', branch: 'orphan', commit: 'a1', isMain: false },
        { path: '/second/old', branch: 'old', commit: 'a2', isMain: false },
        { path: '/second', branch: 'main', commit: 'a3', isMain: true },
        { path: '/second/recent', branch: 'recent', commit: 'a4', isMain: false },
        { path: '/second/busy', branch: 'busy', commit: 'a5', isMain: false },
      ]),
    );
    seedProjectThreads({
      p2: [
        buildThread({
          id: 't-old',
          projectId: 'p2',
          status: 'completed',
          worktreePath: '/second/old',
          updatedAt: '2026-01-01T00:00:00Z',
        }),
        buildThread({
          id: 't-recent',
          projectId: 'p2',
          status: 'completed',
          worktreePath: '/second/recent',
          updatedAt: '2026-06-01T00:00:00Z',
        }),
        buildThread({
          id: 't-busy',
          projectId: 'p2',
          status: 'running',
          worktreePath: '/second/busy',
          updatedAt: '2025-01-01T00:00:00Z',
        }),
      ],
    });
    renderWithProviders(<WorktreesPanel />);

    await screen.findByTestId('worktree-row-orphan');
    const rows = screen
      .getAllByTestId(/^worktree-row-/)
      .map((row) => row.getAttribute('data-testid'));
    expect(rows).toEqual([
      'worktree-row-main',
      'worktree-row-busy',
      'worktree-row-recent',
      'worktree-row-old',
      'worktree-row-orphan',
    ]);
    // A worktree no thread works in says so, its name in the same column as the titles.
    const orphan = screen.getByTestId('worktree-row-orphan');
    expect(within(orphan).getByTestId('worktree-no-thread-icon')).toBeInTheDocument();
    expect(orphan).toHaveTextContent('no thread');
    expect(
      within(screen.getByTestId('worktree-row-busy')).queryByTestId('worktree-no-thread-icon'),
    ).toBeNull();
  });

  test('removes worktrees from project settings', () => {
    const items = buildSettingsItems({ selectedProjectId: 'p1', isProjectAdmin: true });
    expect(items.map((item) => item.id)).not.toContain('worktrees');
    expect(routableSettingsIds.has('worktrees')).toBe(false);
  });
});
