import type { ResultAsync } from 'neverthrow';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { fetchForThread, fetchProjectStatus } from '@/data/git-status/actions';
import { api } from '@/lib/api';

interface BranchActionsOptions {
  hasGitContext: boolean;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  /** Mark the history stale once the action settles (see useGitHistoryAutoRefresh). */
  invalidateHistory: () => void;
}

/** Bypass the status cooldown after a branch action so badges update at once. */
function forceRefreshGitStatus(
  threadId: string | undefined,
  projectModeId: string | null,
): Promise<void> {
  if (threadId) return fetchForThread(threadId, true);
  if (projectModeId) return fetchProjectStatus(projectModeId, true);
  return Promise.resolve();
}

/**
 * Push / pull from the commit graph. Both share one lifecycle: lock, run,
 * toast, then resync status and history. The history reload goes through the
 * auto-refresh machine so it merges with the reload the status change
 * triggers, instead of loading twice.
 */
export function useBranchActions({
  hasGitContext,
  effectiveThreadId,
  projectModeId,
  invalidateHistory,
}: BranchActionsOptions) {
  const { t } = useTranslation();
  const [branchActionInProgress, setBranchActionInProgress] = useState<string | null>(null);

  const runBranchAction = useCallback(
    async (
      key: string,
      run: () => ResultAsync<unknown, { message: string }>,
      successMessage: string,
      failureMessage: (message: string) => string,
    ) => {
      if (!hasGitContext || branchActionInProgress) return;
      setBranchActionInProgress(key);
      const result = await run();
      if (result.isOk()) toast.success(successMessage);
      else toast.error(failureMessage(result.error.message));
      setBranchActionInProgress(null);
      await forceRefreshGitStatus(effectiveThreadId, projectModeId);
      invalidateHistory();
    },
    [hasGitContext, branchActionInProgress, effectiveThreadId, projectModeId, invalidateHistory],
  );

  const pushBranch = useCallback(
    (branch: string) =>
      runBranchAction(
        `push:${branch}`,
        () =>
          effectiveThreadId
            ? api.pushBranch(effectiveThreadId, branch)
            : api.projectPushBranch(projectModeId!, branch),
        t('history.pushBranchSuccess', { branch, defaultValue: `Pushed ${branch} to origin` }),
        (message) => t('review.pushFailed', { message, defaultValue: `Push failed: ${message}` }),
      ),
    [runBranchAction, effectiveThreadId, projectModeId, t],
  );

  const pullCurrentBranch = useCallback(
    (branch: string) =>
      runBranchAction(
        `pull:${branch}`,
        () =>
          effectiveThreadId
            ? api.pull(effectiveThreadId, 'ff-only')
            : api.projectPull(projectModeId!, 'ff-only'),
        t('review.pullSuccess', 'Pulled successfully'),
        (message) => t('review.pullFailed', { message, defaultValue: `Pull failed: ${message}` }),
      ),
    [runBranchAction, effectiveThreadId, projectModeId, t],
  );

  return { branchActionInProgress, pushBranch, pullCurrentBranch };
}
