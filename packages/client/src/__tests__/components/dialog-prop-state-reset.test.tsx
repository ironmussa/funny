import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { PullStrategyDialog } from '@/components/pull-strategy-dialog';
import { WorktreeDeleteDialog } from '@/components/WorktreeDeleteDialog';

const worktreeStatus = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  api: { worktreeStatus },
}));

describe('dialog state reset on a new opening', () => {
  test('restores the default pull strategy after reopening', () => {
    const onChoose = vi.fn();
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      errorMessage: 'diverged',
      onChoose,
    };
    const view = render(<PullStrategyDialog {...props} />);

    fireEvent.click(screen.getByTestId('pull-strategy-merge'));
    fireEvent.click(screen.getByTestId('pull-strategy-confirm'));
    expect(onChoose).toHaveBeenLastCalledWith('merge');

    view.rerender(<PullStrategyDialog {...props} open={false} />);
    view.rerender(<PullStrategyDialog {...props} open />);
    fireEvent.click(screen.getByTestId('pull-strategy-confirm'));

    expect(onChoose).toHaveBeenLastCalledWith('rebase');
  });

  test('clears the branch deletion option after reopening', async () => {
    worktreeStatus.mockResolvedValue({
      match: (onSuccess: (status: object) => void) =>
        onSuccess({ unpushedCommitCount: 0, dirtyFileCount: 0, hasRemoteBranch: true }),
    });
    const onConfirm = vi.fn();
    const props = {
      open: true,
      target: {
        threadId: 'thread-1',
        projectId: 'project-1',
        title: 'Thread',
        worktreePath: '/tmp/worktree',
        branchName: 'feature/test',
      },
      onCancel: vi.fn(),
      onConfirm,
    };
    const view = render(<WorktreeDeleteDialog {...props} />);

    const checkbox = await screen.findByRole('checkbox');
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId('worktree-delete-confirm'));
    expect(onConfirm).toHaveBeenLastCalledWith({ deleteBranch: true });

    view.rerender(<WorktreeDeleteDialog {...props} open={false} />);
    view.rerender(<WorktreeDeleteDialog {...props} open />);
    fireEvent.click(await screen.findByTestId('worktree-delete-confirm'));

    expect(onConfirm).toHaveBeenLastCalledWith({ deleteBranch: false });
  });
});
