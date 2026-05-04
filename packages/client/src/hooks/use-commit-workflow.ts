import type { GitWorkflowRequest } from '@funny/shared';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { gitApi } from '@/lib/api/git';
import { projectsApi } from '@/lib/api/projects';
import { toastError } from '@/lib/toast-error';
import { useCommitProgressStore, type CommitProgressEntry } from '@/stores/commit-progress-store';
import { useDraftStore } from '@/stores/draft-store';
import { useThreadStore } from '@/stores/thread-store';

export type CommitAction = 'commit' | 'commit-push' | 'commit-pr' | 'commit-merge' | 'amend';

interface UseCommitWorkflowArgs {
  hasGitContext: boolean;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  threadProjectId: string | undefined;
  selectedProjectId: string | null;
  summaries: { path: string; staged: boolean }[];
  checkedFiles: Set<string>;
  commitTitle: string;
  commitBody: string;
  draftId: string | null | undefined;
  setCommitTitle: (v: string) => void;
  setCommitBody: (v: string) => void;
  baseBranch: string | undefined;
  threadBranch: string | undefined;
  currentBranch: string | undefined;
  /** Trigger a full ReviewPane diff/summary refresh after a workflow completes. */
  refresh: () => Promise<void> | void;
}

export interface UseCommitWorkflowResult {
  // Action selector
  selectedAction: CommitAction;
  setSelectedAction: Dispatch<SetStateAction<CommitAction>>;

  // In-progress flags (cleared by the watcher when commitEntry disappears)
  actionInProgress: string | null;
  /** Exposed so the parent can clear it manually (e.g., from the "Dismiss" button on a failed workflow). */
  setActionInProgress: Dispatch<SetStateAction<string | null>>;
  pushInProgress: boolean;
  mergeInProgress: boolean;
  prInProgress: boolean;

  // Dialogs
  prDialog: { title: string; body: string } | null;
  setPrDialog: Dispatch<SetStateAction<{ title: string; body: string } | null>>;
  mergeDialog: { targetBranch: string; branches: string[]; loading: boolean } | null;
  setMergeDialog: Dispatch<
    SetStateAction<{ targetBranch: string; branches: string[]; loading: boolean } | null>
  >;

  // Conflict + auto-close hooks
  hasRebaseConflict: boolean;
  setHasRebaseConflict: Dispatch<SetStateAction<boolean>>;
  justCompletedWorkflowRef: React.MutableRefObject<boolean>;

  // Commit progress (the parent renders the progress UI via these)
  commitInProgress: boolean;
  commitEntry: CommitProgressEntry | undefined;
  commitProgressId: string;

  // Handlers
  handleCommitAction: () => Promise<void>;
  handlePushOnly: () => Promise<void>;
  openMergeDialog: () => Promise<void>;
  handleMergeWithTarget: () => Promise<void>;
  handleCreatePROnly: () => Promise<void>;
}

/**
 * Owns the entire commit / push / PR / merge workflow inside ReviewPane:
 * the action-selector state, the in-progress flags, the merge & PR dialogs,
 * the rebase-conflict flag, and — critically — the commit-progress watcher
 * effect that clears all of those when the server-driven workflow completes.
 *
 * The watcher and the handlers form a tight loop: each handler kicks off a
 * workflow on the server and sets its own in-progress flag; the watcher
 * subscribes to the commit-progress store and clears the flags when the
 * workflow finishes (or fails). Splitting them apart breaks the loop, so
 * they're co-located here.
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function useCommitWorkflow({
  hasGitContext,
  effectiveThreadId,
  projectModeId,
  threadProjectId,
  selectedProjectId,
  summaries,
  checkedFiles,
  commitTitle,
  commitBody,
  draftId,
  setCommitTitle,
  setCommitBody,
  baseBranch,
  threadBranch,
  currentBranch,
  refresh,
}: UseCommitWorkflowArgs): UseCommitWorkflowResult {
  const { t } = useTranslation();
  const { clearCommitDraft } = useDraftStore();

  const [selectedAction, setSelectedAction] = useState<CommitAction>('commit');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [pushInProgress, setPushInProgress] = useState(false);
  const [mergeInProgress, setMergeInProgress] = useState(false);
  const [prInProgress, setPrInProgress] = useState(false);
  const [prDialog, setPrDialog] = useState<{ title: string; body: string } | null>(null);
  const [mergeDialog, setMergeDialog] = useState<{
    targetBranch: string;
    branches: string[];
    loading: boolean;
  } | null>(null);
  const [hasRebaseConflict, setHasRebaseConflict] = useState(false);

  const commitLockRef = useRef(false);
  const justCompletedWorkflowRef = useRef(false);

  // Commit progress (per-thread, persists across thread switches)
  const commitProgressId = effectiveThreadId || projectModeId || '';
  const commitEntry = useCommitProgressStore((s) => s.activeCommits[commitProgressId]);
  const commitInProgress = !!commitEntry;

  // React to server-driven workflow progress (completion, failure, cleanup).
  // This is the keystone effect that clears all the in-progress flags when
  // a workflow finishes — without it, the action buttons stay disabled.
  const prevCommitEntryRef = useRef(commitEntry);
  useEffect(() => {
    const prev = prevCommitEntryRef.current;
    prevCommitEntryRef.current = commitEntry;

    // Workflow finished (entry removed by finishCommit after completed)
    if (prev && !commitEntry) {
      setActionInProgress(null);
      commitLockRef.current = false;
      setPushInProgress(false);
      setMergeInProgress(false);
      setPrInProgress(false);
      justCompletedWorkflowRef.current = true;
      // Refresh diffs and git status
      refresh();
      if (effectiveThreadId && (prev.action === 'commit-merge' || prev.action === 'merge')) {
        // Refresh both active thread and sidebar thread list
        useThreadStore.getState().refreshActiveThread();
        useThreadStore.getState().refreshAllLoadedThreads();
      }
      return;
    }

    if (!commitEntry) return;

    const hasFailed = commitEntry.steps.some((s) => s.status === 'failed');
    const allCompleted = commitEntry.steps.every((s) => s.status === 'completed');

    if (hasFailed) {
      setActionInProgress(null);
      commitLockRef.current = false;
      setPushInProgress(false);
      setMergeInProgress(false);
      setPrInProgress(false);

      // Detect rebase/merge conflicts
      const mergeStep = commitEntry.steps.find((s) => s.id === 'merge' && s.status === 'failed');
      if (mergeStep?.error) {
        const lower = mergeStep.error.toLowerCase();
        if (
          lower.includes('conflict') ||
          lower.includes('rebase failed') ||
          lower.includes('merge failed') ||
          lower.includes('automatic merge failed') ||
          lower.includes('fix conflicts') ||
          lower.includes('could not apply')
        ) {
          setHasRebaseConflict(true);
        }
      }

      // Detect hook failures for toast
      const hookStep = commitEntry.steps.find((s) => s.id === 'hooks' && s.status === 'failed');
      if (hookStep?.error) {
        const failedHook = hookStep.subItems?.find((si) => si.status === 'failed');
        toast.error(
          t('review.hookFailed', 'Pre-commit hook failed: {{hook}}', {
            hook: failedHook?.label || 'unknown',
          }),
        );
      }

      refresh();
    }

    if (allCompleted && prev && !prev.steps.every((s) => s.status === 'completed')) {
      // Just transitioned to all-completed — show success toast.
      // Note: push toast is handled in use-ws.ts to avoid duplication.
      const action = commitEntry.action;
      if (action === 'push') {
        // handled in use-ws.ts
      } else if (action === 'merge' || action === 'commit-merge') {
        toast.success(
          t('review.mergeSuccess', {
            branch: threadBranch || 'branch',
            target: baseBranch || 'base',
            defaultValue: `Merged "${threadBranch || 'branch'}" into "${baseBranch || 'base'}" successfully`,
          }),
        );
      } else if (action === 'create-pr') {
        toast.success(t('review.prSuccess', 'Pull request created'));
      } else {
        toast.success(t('review.commitSuccess', 'Changes committed successfully'));
      }
    }
  }, [commitEntry]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCommitAction = useCallback(async () => {
    if (!hasGitContext || !commitTitle.trim() || checkedFiles.size === 0 || actionInProgress)
      return;
    if (commitLockRef.current) return;
    commitLockRef.current = true;
    setActionInProgress(selectedAction);

    const toUnstage = summaries
      .filter((f) => f.staged && !checkedFiles.has(f.path))
      .map((f) => f.path);
    const toStage = Array.from(checkedFiles).filter((p) => {
      const s = summaries.find((f) => f.path === p);
      return s && !s.staged;
    });

    const commitMsg = commitBody.trim()
      ? `${commitTitle.trim()}\n\n${commitBody.trim()}`
      : commitTitle.trim();

    const params: GitWorkflowRequest = {
      action: selectedAction,
      message: commitMsg,
      filesToStage: toStage,
      filesToUnstage: toUnstage,
      amend: selectedAction === 'amend',
      prTitle: selectedAction === 'commit-pr' ? commitTitle.trim() : undefined,
      prBody: selectedAction === 'commit-pr' ? commitBody.trim() : undefined,
      cleanup: selectedAction === 'commit-merge',
    };

    const result = effectiveThreadId
      ? await gitApi.startWorkflow(effectiveThreadId, params)
      : await gitApi.projectStartWorkflow(projectModeId!, params);

    if (result.isErr()) {
      toastError(result.error);
      setActionInProgress(null);
      commitLockRef.current = false;
      return;
    }

    // Progress is now driven by WS events (workflow events in the timeline).
    setCommitTitle('');
    setCommitBody('');
    if (draftId) clearCommitDraft(draftId);
  }, [
    hasGitContext,
    commitTitle,
    commitBody,
    checkedFiles,
    actionInProgress,
    selectedAction,
    summaries,
    effectiveThreadId,
    projectModeId,
    draftId,
    clearCommitDraft,
    setCommitTitle,
    setCommitBody,
  ]);

  const handlePushOnly = useCallback(async () => {
    if (!hasGitContext || pushInProgress) return;
    setPushInProgress(true);

    const result = effectiveThreadId
      ? await gitApi.startWorkflow(effectiveThreadId, { action: 'push' })
      : await gitApi.projectStartWorkflow(projectModeId!, { action: 'push' });

    if (result.isErr()) {
      toastError(result.error);
      setPushInProgress(false);
    }
    // pushInProgress will be cleared by the watcher when commitEntry disappears.
  }, [hasGitContext, pushInProgress, effectiveThreadId, projectModeId]);

  const openMergeDialog = useCallback(async () => {
    const pid = threadProjectId ?? selectedProjectId ?? '';
    if (!pid) return;

    setMergeDialog({ targetBranch: baseBranch || '', branches: [], loading: true });

    const result = await projectsApi.listBranches(pid);
    if (result.isOk()) {
      const data = result.value;
      const branches = data.branches.filter((b) => b !== currentBranch);
      const defaultTarget =
        baseBranch && branches.includes(baseBranch)
          ? baseBranch
          : data.defaultBranch && branches.includes(data.defaultBranch)
            ? data.defaultBranch
            : branches[0] || '';
      setMergeDialog((prev) =>
        prev ? { ...prev, targetBranch: defaultTarget, branches, loading: false } : null,
      );
    } else {
      setMergeDialog(null);
      toastError(result.error);
    }
  }, [threadProjectId, selectedProjectId, baseBranch, currentBranch]);

  const handleMergeWithTarget = useCallback(async () => {
    if (!hasGitContext || mergeInProgress || !mergeDialog?.targetBranch) return;
    setMergeInProgress(true);

    const params: GitWorkflowRequest = {
      action: 'merge',
      cleanup: true,
      targetBranch: mergeDialog.targetBranch,
    };

    const result = effectiveThreadId
      ? await gitApi.startWorkflow(effectiveThreadId, params)
      : await gitApi.projectStartWorkflow(projectModeId!, params);

    if (result.isErr()) {
      toastError(result.error);
      setMergeInProgress(false);
    }
    setMergeDialog(null);
    // mergeInProgress will be cleared by the watcher when commitEntry disappears.
  }, [hasGitContext, mergeInProgress, mergeDialog, effectiveThreadId, projectModeId]);

  const handleCreatePROnly = useCallback(async () => {
    if (!hasGitContext || prInProgress || !prDialog) return;
    setPrInProgress(true);

    const result = effectiveThreadId
      ? await gitApi.startWorkflow(effectiveThreadId, {
          action: 'create-pr',
          prTitle: prDialog.title.trim(),
          prBody: prDialog.body.trim(),
        })
      : await gitApi.projectStartWorkflow(projectModeId!, {
          action: 'create-pr',
          prTitle: prDialog.title.trim(),
          prBody: prDialog.body.trim(),
        });

    if (result.isErr()) {
      toastError(result.error);
      setPrInProgress(false);
      return;
    }
    setPrDialog(null);
    // prInProgress will be cleared by the watcher when commitEntry disappears.
  }, [hasGitContext, prInProgress, prDialog, effectiveThreadId, projectModeId]);

  return {
    selectedAction,
    setSelectedAction,
    actionInProgress,
    setActionInProgress,
    pushInProgress,
    mergeInProgress,
    prInProgress,
    prDialog,
    setPrDialog,
    mergeDialog,
    setMergeDialog,
    hasRebaseConflict,
    setHasRebaseConflict,
    justCompletedWorkflowRef,
    commitInProgress,
    commitEntry,
    commitProgressId,
    handleCommitAction,
    handlePushOnly,
    openMergeDialog,
    handleMergeWithTarget,
    handleCreatePROnly,
  };
}
