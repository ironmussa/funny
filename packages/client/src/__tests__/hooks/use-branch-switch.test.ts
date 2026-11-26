import { describe, expect, mock, test, vi } from 'bun:test';

import { act, renderHook } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import type { ReactElement } from 'react';

const checkoutPreflight = vi.fn(() =>
  okAsync({ canCheckout: false, hasDirtyFiles: true, currentBranch: 'main' }),
);
const checkout = vi.fn(() => okAsync({ worktreePath: null }));
mock.module('@/lib/api', () => ({ api: { checkoutPreflight, checkout } }));
mock.module('@/data/projects/branches', () => ({ readProjectCurrentBranch: () => 'main' }));
mock.module('@/data/git-status/actions', () => ({ fetchProjectStatus: vi.fn() }));
mock.module('@/components/ui/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useBranchSwitch } from '@/hooks/use-branch-switch';

type DialogProps = {
  open: boolean;
  targetBranch: string;
  onSwitch: (strategy: 'stash' | 'carry') => Promise<void>;
  onCancel: () => void;
};
const dialogProps = (dialog: unknown) => (dialog as ReactElement<DialogProps>).props;

describe('useBranchSwitch', () => {
  test('dirty files open the dialog; cancelling resolves the check with false', async () => {
    const { result } = renderHook(() => useBranchSwitch());
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.ensureBranch('p1', 'feature');
    });
    expect(dialogProps(result.current.branchSwitchDialog).open).toBe(true);
    expect(dialogProps(result.current.branchSwitchDialog).targetBranch).toBe('feature');

    act(() => dialogProps(result.current.branchSwitchDialog).onCancel());
    expect(await pending).toBe(false);
    expect(dialogProps(result.current.branchSwitchDialog).open).toBe(false);
  });

  test('switching from the dialog checks out and resolves the check with true', async () => {
    const { result } = renderHook(() => useBranchSwitch());
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.ensureBranch('p1', 'feature');
    });
    await act(async () => dialogProps(result.current.branchSwitchDialog).onSwitch('stash'));
    expect(checkout).toHaveBeenCalledWith('p1', 'feature', 'stash');
    expect(await pending).toBe(true);
    expect(dialogProps(result.current.branchSwitchDialog).open).toBe(false);
  });
});
