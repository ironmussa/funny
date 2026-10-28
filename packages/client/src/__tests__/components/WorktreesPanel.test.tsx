import { screen, waitFor } from '@testing-library/react';
import { okAsync, ResultAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { WorktreesPanel } from '@/components/review-pane/panels/WorktreesPanel';
import { buildSettingsItems, routableSettingsIds } from '@/components/settings/items';
import { api } from '@/lib/api';
import { useProjectStore } from '@/stores/project-store';

import { renderWithProviders } from '../helpers/render';

const context = vi.hoisted(() => ({
  remoteCheckProjectId: 'p2' as string | null,
  viewerReadOnly: false,
  basePath: '/second/feature',
}));
vi.mock('@/components/review-pane/ReviewPaneStateContext', () => ({
  useReviewPaneContext: () => context,
}));
vi.mock('@/lib/api', () => ({
  api: { listWorktrees: vi.fn(), listBranches: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  context.remoteCheckProjectId = 'p2';
  context.viewerReadOnly = false;
  context.basePath = '/second/feature';
  useProjectStore.setState({
    selectedProjectId: 'p1',
    projects: [
      { id: 'p1', name: 'First', path: '/first' },
      { id: 'p2', name: 'Second', path: '/second' },
    ] as any,
  });
  vi.mocked(api.listWorktrees).mockReturnValue(
    okAsync([
      { path: '/second/feature', branch: 'feature/test', commit: 'abcdef12', isMain: false },
    ]),
  );
  vi.mocked(api.listBranches).mockReturnValue(
    okAsync({
      branches: ['main'],
      defaultBranch: 'main',
    }) as ReturnType<typeof api.listBranches>,
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
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  test('does not load another project when the review target is absent', () => {
    context.remoteCheckProjectId = null;
    renderWithProviders(<WorktreesPanel />);
    expect(api.listWorktrees).not.toHaveBeenCalled();
  });

  test('uses a full-height centered loading state', () => {
    vi.mocked(api.listWorktrees).mockReturnValue(
      ResultAsync.fromSafePromise(new Promise<never>(() => {})),
    );
    renderWithProviders(<WorktreesPanel />);
    expect(screen.getByTestId('worktree-settings-loading')).toHaveClass(
      'flex-1',
      'flex-col',
      'items-center',
      'justify-center',
    );
  });

  test('lets the empty message fill the available panel height', async () => {
    vi.mocked(api.listWorktrees).mockReturnValue(okAsync([]));
    renderWithProviders(<WorktreesPanel />);
    expect(await screen.findByTestId('worktree-settings-empty')).toHaveClass(
      'flex-1',
      'items-center',
      'justify-center',
    );
  });

  test('distinguishes the main checkout from the active linked worktree', async () => {
    vi.mocked(api.listWorktrees).mockReturnValue(
      okAsync([
        { path: '/second', branch: 'main', commit: 'abcdef12', isMain: true },
        { path: '/second/feature', branch: 'feature/test', commit: 'abcdef12', isMain: false },
      ]),
    );
    const view = renderWithProviders(<WorktreesPanel />);
    await screen.findByText('feature/test');
    const mainBadge = screen.getByText('Main');
    const activeBadge = screen.getByText('Active');
    expect(mainBadge.parentElement).toHaveTextContent('main');
    expect(activeBadge.parentElement).toHaveTextContent('feature/test');
    context.basePath = '/second';
    view.rerender(<WorktreesPanel />);
    expect(screen.getByText('Main').parentElement).toContainElement(screen.getByText('Active'));
    context.basePath = '';
    view.rerender(<WorktreesPanel />);
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  test('removes worktrees from project settings', () => {
    const items = buildSettingsItems({ selectedProjectId: 'p1', isProjectAdmin: true });
    expect(items.map((item) => item.id)).not.toContain('worktrees');
    expect(routableSettingsIds.has('worktrees')).toBe(false);
  });
});
