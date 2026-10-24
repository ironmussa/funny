import { screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { WorktreesPanel } from '@/components/review-pane/panels/WorktreesPanel';
import { buildSettingsItems, routableSettingsIds } from '@/components/settings/items';
import { api } from '@/lib/api';
import { useProjectStore } from '@/stores/project-store';

import { renderWithProviders } from '../helpers/render';

const context = vi.hoisted(() => ({
  remoteCheckProjectId: 'p2' as string | null,
  viewerReadOnly: false,
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

  test('removes worktrees from project settings', () => {
    const items = buildSettingsItems({ selectedProjectId: 'p1', isProjectAdmin: true });
    expect(items.map((item) => item.id)).not.toContain('worktrees');
    expect(routableSettingsIds.has('worktrees')).toBe(false);
  });
});
