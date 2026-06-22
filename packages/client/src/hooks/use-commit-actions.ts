import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { useGitStatusStore } from '@/stores/git-status-store';

/** Commit operations offered from the graph context menu + detail dialog that
 * run behind a confirmation dialog (they mutate the working branch / history). */
export type CommitActionKind = 'checkout' | 'revert' | 'reset' | 'cherry-pick';
export type BranchCommitActionKind = 'merge-current-into' | 'rebase-current-onto';
export type ConfirmedCommitActionKind = CommitActionKind | BranchCommitActionKind;

export interface PendingCommitAction {
  kind: ConfirmedCommitActionKind;
  /** Commit hash for commit actions; target branch for branch actions. */
  hash: string;
}

interface UseCommitActionsOptions {
  /** Thread context (mutually exclusive with projectModeId). */
  effectiveThreadId?: string;
  /** Project context (mutually exclusive with effectiveThreadId). */
  projectModeId: string | null;
  /** Called after any action completes (success or failure) to reload the log. */
  onAfterAction: () => void;
  /** Called once after a *successful* action — e.g. the detail dialog closes itself. */
  onSuccess?: (kind: ConfirmedCommitActionKind) => void;
}

/**
 * Shared logic for the checkout / revert / hard-reset commit operations, used by
 * both {@link CommitActionsMenu} (graph) and the CommitDetailDialog (history).
 *
 * Owns the confirm-flow state (`pending`) and runs the actual API call + success
 * toast + git-status refresh, so neither surface duplicates the thread-vs-project
 * branching or the post-action bookkeeping. The confirm UI itself lives in the
 * shared {@link CommitActionConfirm} component, driven by the values returned here.
 */
export function useCommitActions({
  effectiveThreadId,
  projectModeId,
  onAfterAction,
  onSuccess,
}: UseCommitActionsOptions) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingCommitAction | null>(null);
  const [inProgress, setInProgress] = useState(false);
  const hasGitContext = !!(effectiveThreadId || projectModeId);

  const refreshAfterAction = useCallback(() => {
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId, true);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId, true);
    onAfterAction();
  }, [effectiveThreadId, projectModeId, onAfterAction]);

  /** Open the confirm dialog for a given action + commit. No-op without git context. */
  const request = useCallback(
    (kind: ConfirmedCommitActionKind, hash: string) => {
      if (hasGitContext) setPending({ kind, hash });
    },
    [hasGitContext],
  );

  const cancel = useCallback(() => setPending(null), []);

  /** Run the currently-pending action (called by the confirm dialog). */
  const confirm = useCallback(async () => {
    if (!pending || inProgress || !hasGitContext) return;
    const { kind, hash } = pending;
    setInProgress(true);
    const run = () => {
      switch (kind) {
        case 'checkout':
          return effectiveThreadId
            ? api.checkoutCommit(effectiveThreadId, hash)
            : api.projectCheckoutCommit(projectModeId!, hash);
        case 'revert':
          return effectiveThreadId
            ? api.revertCommit(effectiveThreadId, hash)
            : api.projectRevertCommit(projectModeId!, hash);
        case 'reset':
          return effectiveThreadId
            ? api.resetHard(effectiveThreadId, hash)
            : api.projectResetHard(projectModeId!, hash);
        case 'cherry-pick':
          return effectiveThreadId
            ? api.cherryPick(effectiveThreadId, hash)
            : api.projectCherryPick(projectModeId!, hash);
        case 'merge-current-into':
          return effectiveThreadId
            ? api.mergeCurrentBranchInto(effectiveThreadId, hash)
            : api.projectMergeCurrentBranchInto(projectModeId!, hash);
        case 'rebase-current-onto':
          return effectiveThreadId
            ? api.rebaseCurrentBranchOnto(effectiveThreadId, hash)
            : api.projectRebaseCurrentBranchOnto(projectModeId!, hash);
      }
    };
    const result = await run();
    if (result.isOk()) {
      const successMsg: Record<ConfirmedCommitActionKind, string> = {
        checkout: t('history.checkoutSuccess', 'Switched to commit (detached HEAD)'),
        revert: t('history.revertSuccess', 'Commit reverted successfully'),
        reset: t('history.resetSuccess', 'Branch reset to this commit'),
        'cherry-pick': t('history.cherryPickSuccess', 'Commit cherry-picked onto current branch'),
        'merge-current-into': t('history.mergeCurrentIntoSuccess', {
          branch: hash,
          defaultValue: `Merged current branch into ${hash}`,
        }),
        'rebase-current-onto': t('history.rebaseCurrentOntoSuccess', {
          branch: hash,
          defaultValue: `Rebased current branch onto ${hash}`,
        }),
      };
      toast.success(successMsg[kind]);
      onSuccess?.(kind);
    } else {
      toastError(result.error);
    }
    setInProgress(false);
    setPending(null);
    refreshAfterAction();
  }, [
    pending,
    inProgress,
    hasGitContext,
    effectiveThreadId,
    projectModeId,
    onSuccess,
    refreshAfterAction,
    t,
  ]);

  /**
   * Push a specific local branch to origin. Runs immediately (no confirm) —
   * pushing matches the confirm-free push affordances elsewhere in the app, and
   * the branch name is the local-only ref decorating the selected commit.
   */
  const pushBranch = useCallback(
    async (branch: string) => {
      if (!hasGitContext || inProgress) return;
      setInProgress(true);
      const result = await (effectiveThreadId
        ? api.pushBranch(effectiveThreadId, branch)
        : api.projectPushBranch(projectModeId!, branch));
      if (result.isOk()) {
        toast.success(
          t('history.pushBranchSuccess', {
            branch,
            defaultValue: `Pushed ${branch} to origin`,
          }),
        );
      } else {
        toastError(result.error);
      }
      setInProgress(false);
      refreshAfterAction();
    },
    [hasGitContext, inProgress, effectiveThreadId, projectModeId, refreshAfterAction, t],
  );

  /** Create a new branch at `startPoint` and switch to it. Runs immediately. */
  const createBranch = useCallback(
    async (name: string, startPoint: string) => {
      if (!hasGitContext || inProgress) return;
      setInProgress(true);
      const result = await (effectiveThreadId
        ? api.createBranch(effectiveThreadId, name, startPoint)
        : api.projectCreateBranch(projectModeId!, name, startPoint));
      if (result.isOk()) {
        toast.success(
          t('history.createBranchSuccess', {
            branch: name,
            defaultValue: `Created and switched to ${name}`,
          }),
        );
      } else {
        toastError(result.error);
      }
      setInProgress(false);
      refreshAfterAction();
    },
    [hasGitContext, inProgress, effectiveThreadId, projectModeId, refreshAfterAction, t],
  );

  return {
    pending,
    inProgress,
    hasGitContext,
    request,
    cancel,
    confirm,
    pushBranch,
    createBranch,
  };
}
