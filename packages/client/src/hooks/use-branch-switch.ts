import { createElement, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { SwitchBranchDialog } from '@/components/SwitchBranchDialog';
import { api } from '@/lib/api';
import { useBranchPickerStore } from '@/stores/branch-picker-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';

interface DialogState {
  projectId: string;
  targetBranch: string;
  currentBranch: string;
}

/** Shared hook for branch checkout preflight + dialog. */
export function useBranchSwitch() {
  const { t } = useTranslation();

  const [dialogState, setDialogState] = useState<DialogState | null>(null);
  const [loading, setLoading] = useState(false);
  const resolverRef = useRef<((result: boolean) => void) | null>(null);

  /**
   * Ensure the working directory is on `targetBranch`.
   * Returns `true` if the caller may proceed (checkout succeeded or was unnecessary).
   * Returns `false` if the user cancelled or the checkout failed.
   */
  const ensureBranch = useCallback(
    async (projectId: string, targetBranch: string): Promise<boolean> => {
      // Get current branch from the project store (eagerly fetched on expand)
      const currentBranch = useProjectStore.getState().branchByProject[projectId];

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
            resolverRef.current = resolve;
            setDialogState({
              projectId,
              targetBranch,
              currentBranch: serverCurrentBranch ?? currentBranch ?? '',
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
      useGitStatusStore.getState().fetchProjectStatus(projectId, true);
      return true;
    },
    [t],
  );

  const handleSwitch = useCallback(
    async (strategy: 'stash' | 'carry') => {
      if (!dialogState) return;
      setLoading(true);

      const result = await api.checkout(dialogState.projectId, dialogState.targetBranch, strategy);
      setLoading(false);

      if (result.isOk()) {
        if (!result.value.worktreePath) {
          useProjectStore.getState().setBranch(dialogState.projectId, dialogState.targetBranch);
          useBranchPickerStore.getState().setCurrentBranch(dialogState.targetBranch);
          // Force-refresh git status so ReviewPane shows origin info for the new branch
          useGitStatusStore.getState().fetchProjectStatus(dialogState.projectId, true);
        }
        setDialogState(null);
        resolverRef.current?.(true);
        resolverRef.current = null;
      } else {
        toast.error(result.error.message || t('switchBranch.failed', 'Failed to switch branch'));
      }
    },
    [dialogState, t],
  );

  const handleCancel = useCallback(() => {
    setDialogState(null);
    resolverRef.current?.(false);
    resolverRef.current = null;
  }, []);

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
