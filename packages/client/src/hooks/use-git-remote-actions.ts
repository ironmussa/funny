import type { TFunction } from 'i18next';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { isDivergedBranchesError } from '@/components/pull-strategy-dialog';
import { refreshGitStatus } from '@/data/git-status/actions';
import type { PullStrategy } from '@/lib/api/_core';
import { gitApi } from '@/lib/api/git';

/** Pull/fetch run against a thread's worktree, or the project root when there is no thread. */
interface GitRemoteTarget {
  threadId?: string;
  projectId?: string | null;
}

/**
 * Pull, toast the outcome and force-refresh git status so the unpulled badge
 * clears immediately. When an ff-only pull fails because the branch diverged,
 * returns git's message instead (no toast, no refresh) so the caller can offer
 * merge/rebase.
 */
async function pullWithFeedback(
  { threadId, projectId }: GitRemoteTarget,
  strategy: PullStrategy,
  t: TFunction,
): Promise<{ diverged: string } | null> {
  const result = threadId
    ? await gitApi.pull(threadId, strategy)
    : await gitApi.projectPull(projectId!, strategy);
  if (result.isErr()) {
    const msg = result.error.message;
    if (strategy === 'ff-only' && isDivergedBranchesError(msg)) return { diverged: msg };
    toast.error(t('review.pullFailed', { message: msg, defaultValue: `Pull failed: ${msg}` }));
  } else {
    toast.success(t('review.pullSuccess', 'Pulled successfully'));
  }
  void refreshGitStatus(threadId, projectId);
  return null;
}

/**
 * Fetch from origin, toast the outcome and force-refresh git status so the
 * unpulled/unpushed counts update immediately.
 */
async function fetchOriginWithFeedback(
  { threadId, projectId }: GitRemoteTarget,
  t: TFunction,
): Promise<void> {
  const result = threadId
    ? await gitApi.fetchOrigin(threadId)
    : await gitApi.projectFetchOrigin(projectId!);
  if (result.isErr()) {
    const msg = result.error.message;
    const isAuthError =
      /auth|token|credential|permission|denied|403|fatal:/i.test(msg) ||
      result.error.type === 'INTERNAL';
    toast.error(
      isAuthError
        ? t('review.fetchAuthFailed', {
            defaultValue:
              'Fetch failed: authentication error. Check your GitHub token in Settings > Profile.',
          })
        : t('review.fetchFailed', { message: msg, defaultValue: `Fetch failed: ${msg}` }),
    );
  } else {
    toast.success(t('review.fetchSuccess', 'Fetched from origin'));
  }
  void refreshGitStatus(threadId, projectId);
}

interface PullStrategyDialogState {
  open: boolean;
  errorMessage: string;
}

interface UseGitRemoteActionsArgs extends GitRemoteTarget {
  hasGitContext: boolean;
  /** Reload the caller's view (diff, log) after a pull or fetch went through. */
  afterChange: () => void | Promise<void>;
}

/**
 * Pull / fetch buttons shared by the Changes tab and the History tab: the
 * in-progress flags, the merge-or-rebase dialog a diverged ff-only pull opens,
 * and the three handlers.
 */
export function useGitRemoteActions({
  threadId,
  projectId,
  hasGitContext,
  afterChange,
}: UseGitRemoteActionsArgs) {
  const { t } = useTranslation();
  const [pullInProgress, setPullInProgress] = useState(false);
  const [fetchInProgress, setFetchInProgress] = useState(false);
  const [pullStrategyDialog, setPullStrategyDialog] = useState<PullStrategyDialogState>({
    open: false,
    errorMessage: '',
  });

  const runPull = useCallback(
    async (strategy: PullStrategy) => {
      const pull = async () => {
        const outcome = await pullWithFeedback({ threadId, projectId }, strategy, t);
        // A diverged ff-only pull offers merge/rebase instead of the raw git hint.
        if (outcome) {
          setPullStrategyDialog({ open: true, errorMessage: outcome.diverged });
          return;
        }
        await afterChange();
      };
      setPullInProgress(true);
      await pull().finally(() => setPullInProgress(false));
    },
    [threadId, projectId, t, afterChange],
  );

  const handlePull = useCallback(async () => {
    if (!hasGitContext || pullInProgress) return;
    await runPull('ff-only');
  }, [hasGitContext, pullInProgress, runPull]);

  const handlePullStrategyChosen = useCallback(
    async (strategy: Exclude<PullStrategy, 'ff-only'>) => {
      setPullStrategyDialog({ open: false, errorMessage: '' });
      if (pullInProgress) return;
      await runPull(strategy);
    },
    [pullInProgress, runPull],
  );

  const handleFetchOrigin = useCallback(async () => {
    if (!hasGitContext || fetchInProgress) return;
    setFetchInProgress(true);
    await fetchOriginWithFeedback({ threadId, projectId }, t);
    setFetchInProgress(false);
    await afterChange();
  }, [hasGitContext, fetchInProgress, threadId, projectId, t, afterChange]);

  return {
    pullInProgress,
    fetchInProgress,
    pullStrategyDialog,
    setPullStrategyDialog,
    handlePull,
    handlePullStrategyChosen,
    handleFetchOrigin,
  };
}
