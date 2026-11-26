import { createElement, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SwitchBranchDialog } from '@/components/SwitchBranchDialog';
import { toast } from '@/components/ui/toast';
import { fetchProjectStatus } from '@/data/git-status/actions';
import { readProjectCurrentBranch } from '@/data/projects/branches';
import { api } from '@/lib/api';
import { whilePending } from '@/lib/while-pending';
import { useBranchPickerStore } from '@/stores/branch-picker-store';
import { useProjectStore } from '@/stores/project-store';

interface DialogState {
  projectId: string;
  targetBranch: string;
  currentBranch: string;
  /** Settles the `ensureBranch` promise that opened the dialog. */
  resolve: (result: boolean) => void;
}

/** Shared hook for branch checkout preflight + dialog. */
export function useBranchSwitch() {
  const { t } = useTranslation();

  const [dialogState, setDialogState] = useState<DialogState | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * Ensure the working directory is on `targetBranch`.
   * Returns `true` if the caller may proceed (checkout succeeded or was unnecessary).
   * Returns `false` if the user cancelled or the checkout failed.
   */
  const ensureBranch = useCallback(
    async (projectId: string, targetBranch: string): Promise<boolean> => {
      // Current branch from the cached listing (eagerly fetched on expand)
      const currentBranch = readProjectCurrentBranch(projectId);

      if (currentBranch && currentBranch === targetBranch) return true;

      const preflight = await api.checkoutPreflight(projectId, targetBranch);
      if (preflight.isErr()) {
        toast.error(preflight.error.message || t('switchBranch.failed', 'Failed to switch branch'));
        return false;
      }

      const { canCheckout, hasDirtyFiles, currentBranch: serverCurrentBranch } = preflight.value;

      // Already on the target branch (server confirmed)
      if (serverCurrentBranch === targetBranch) return true;

      if (!canCheckout) {
        if (hasDirtyFiles) {
          // Show the switch-branch dialog and wait for the user's choice
          return new Promise<boolean>((resolve) => {
            setDialogState({
              projectId,
              targetBranch,
              currentBranch: serverCurrentBranch ?? currentBranch ?? '',
              resolve,
            });
          });
        }
        // Non-dirty checkout failure (e.g. branch doesn't exist)
        toast.error(
          t('prompt.checkoutBlocked', {
            branch: targetBranch,
            currentBranch: serverCurrentBranch ?? currentBranch,
          }),
          { duration: 8000 },
        );
        return false;
      }

      // canCheckout is true and branches differ — perform the checkout silently
      const checkoutResult = await api.checkout(projectId, targetBranch, 'carry');
      if (checkoutResult.isErr()) {
        toast.error(
          checkoutResult.error.message || t('switchBranch.failed', 'Failed to switch branch'),
        );
        return false;
      }
      if (checkoutResult.value.worktreePath) return true;
      useProjectStore.getState().setBranch(projectId, targetBranch);
      useBranchPickerStore.getState().setCurrentBranch(targetBranch);
      // Force-refresh git status so ReviewPane shows origin info for the new branch
      fetchProjectStatus(projectId, true);
      return true;
    },
    [t],
  );

  const handleSwitch = useCallback(
    async (strategy: 'stash' | 'carry') => {
      if (!dialogState) return;
      await whilePending(setLoading, async () => {
        const result = await api.checkout(
          dialogState.projectId,
          dialogState.targetBranch,
          strategy,
        );
        if (result.isOk()) {
          if (!result.value.worktreePath) {
            useProjectStore.getState().setBranch(dialogState.projectId, dialogState.targetBranch);
            useBranchPickerStore.getState().setCurrentBranch(dialogState.targetBranch);
            fetchProjectStatus(dialogState.projectId, true);
          }
          setDialogState(null);
          dialogState.resolve(true);
        } else {
          toast.error(result.error.message || t('switchBranch.failed', 'Failed to switch branch'));
        }
      });
    },
    [dialogState, t],
  );

  const handleCancel = useCallback(() => {
    setDialogState(null);
    dialogState?.resolve(false);
  }, [dialogState]);

  const branchSwitchDialog = createElement(SwitchBranchDialog, {
    open: !!dialogState,
    onOpenChange: (open: boolean) => {
      if (!open) handleCancel();
    },
    currentBranch: dialogState?.currentBranch ?? '',
    targetBranch: dialogState?.targetBranch ?? '',
    loading,
    onSwitch: handleSwitch,
    onCancel: handleCancel,
  });

  return { ensureBranch, branchSwitchDialog } as const;
}
