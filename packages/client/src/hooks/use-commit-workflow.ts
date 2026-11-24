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

import { useStableCallback } from '@/hooks/use-stable-callback';
import { gitApi } from '@/lib/api/git';
import { projectsApi } from '@/lib/api/projects';
import { toastError } from '@/lib/toast-error';
import { useCommitProgressStore, type CommitProgressEntry } from '@/stores/commit-progress-store';
import { useDraftStore } from '@/stores/draft-store';
import { useThreadStore } from '@/stores/thread-store';

type Translate = ReturnType<typeof useTranslation>['t'];
type EntrySnapshot = { id: string; entry: CommitProgressEntry | undefined };

/** Git output that means a rebase or merge stopped on a conflict. */
const CONFLICT_MARKERS = [
  'conflict',
  'rebase failed',
  'merge failed',
  'automatic merge failed',
  'fix conflicts',
  'could not apply',
];

/**
 * Records the current entry and answers the previous one, or undefined when
 * the previous entry belongs to another thread (the thread just switched).
 */
function takePreviousEntry(
  ref: { current: EntrySnapshot },
  id: string,
  entry: CommitProgressEntry | undefined,
): CommitProgressEntry | undefined {
  const previous = ref.current;
  ref.current = { id, entry };
  return previous.id === id ? previous.entry : undefined;
}

function allStepsCompleted(entry: CommitProgressEntry): boolean {
  return entry.steps.every((s) => s.status === 'completed');
}

function hasFailedStep(entry: CommitProgressEntry): boolean {
  return entry.steps.some((s) => s.status === 'failed');
}

/** The entry has just become all-completed (it was not on the previous update). */
function justCompleted(entry: CommitProgressEntry, prev: CommitProgressEntry | undefined): boolean {
  return allStepsCompleted(entry) && !!prev && !allStepsCompleted(prev);
}

function failedStep(entry: CommitProgressEntry, id: string) {
  return entry.steps.find((s) => s.id === id && s.status === 'failed');
}

function isRebaseConflict(entry: CommitProgressEntry): boolean {
  const error = failedStep(entry, 'merge')?.error?.toLowerCase();
  return !!error && CONFLICT_MARKERS.some((marker) => error.includes(marker));
}

/** The label of the pre-commit hook that failed, or null when the hooks step did not fail. */
function failedHookLabel(entry: CommitProgressEntry): string | null {
  const hooks = failedStep(entry, 'hooks');
  if (!hooks?.error) return null;
  return failedSubItemLabel(hooks);
}

function failedSubItemLabel(step: NonNullable<ReturnType<typeof failedStep>>): string {
  return step.subItems?.find((si) => si.status === 'failed')?.label || 'unknown';
}

function isMergeAction(action: string): boolean {
  return action === 'merge' || action === 'commit-merge';
}

/** The success toast for a finished workflow; null for push, which use-ws.ts announces. */
function successMessage(
  action: string,
  t: Translate,
  threadBranch: string | undefined,
  baseBranch: string | undefined,
): string | null {
  if (action === 'push') return null;
  if (isMergeAction(action)) return mergeSuccessMessage(t, threadBranch, baseBranch);
  if (action === 'create-pr') return t('review.prSuccess', 'Pull request created');
  return t('review.commitSuccess', 'Changes committed successfully');
}

function mergeSuccessMessage(
  t: Translate,
  threadBranch: string | undefined,
  baseBranch: string | undefined,
): string {
  const branch = threadBranch || 'branch';
  const target = baseBranch || 'base';
  return t('review.mergeSuccess', {
    branch,
    target,
    defaultValue: `Merged "${branch}" into "${target}" successfully`,
  });
}

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

  useClearOnWorkflowEnd(
    commitProgressId,
    () => {
      setActionInProgress(null);
      commitLockRef.current = false;
      setPushInProgress(false);
      setMergeInProgress(false);
      setPrInProgress(false);
      // A completion marker left by the previous thread must not close this
      // thread's pane; a workflow ending here sets it again just below.
      justCompletedWorkflowRef.current = false;
    },
    (action) => {
      justCompletedWorkflowRef.current = true;
      // Refresh diffs and git status
      refresh();
      if (effectiveThreadId && (action === 'commit-merge' || action === 'merge')) {
        // Refresh both active thread and sidebar thread list
        useThreadStore.getState().refreshActiveThread();
        useThreadStore.getState().refreshAllLoadedThreads();
      }
    },
  );

  // React to server-driven progress of the running workflow (failure, success).
  const prevCommitEntryRef = useRef({ id: commitProgressId, entry: commitEntry });
  /** The running workflow failed: release the actions, flag a conflict, name a failed hook. */
  const handleWorkflowFailure = (entry: CommitProgressEntry) => {
    setActionInProgress(null);
    commitLockRef.current = false;
    setPushInProgress(false);
    setMergeInProgress(false);
    setPrInProgress(false);
    if (isRebaseConflict(entry)) setHasRebaseConflict(true);
    const hook = failedHookLabel(entry);
    if (hook) toast.error(t('review.hookFailed', 'Pre-commit hook failed: {{hook}}', { hook }));
    refresh();
  };

  /** The workflow just finished: say so (push has its own toast in use-ws.ts). */
  const announceSuccess = (action: string) => {
    const message = successMessage(action, t, threadBranch, baseBranch);
    if (message) toast.success(message);
  };

  const onCommitEntryChange = useStableCallback(() => {
    const prev = takePreviousEntry(prevCommitEntryRef, commitProgressId, commitEntry);
    if (!commitEntry) return;
    if (hasFailedStep(commitEntry)) handleWorkflowFailure(commitEntry);
    if (justCompleted(commitEntry, prev)) announceSuccess(commitEntry.action);
  });
  useEffect(() => {
    onCommitEntryChange();
  }, [commitProgressId, commitEntry, onCommitEntryChange]);

  const handleCommitAction = useCallback(async () => {
    if (!hasGitContext || !commitTitle.trim() || checkedFiles.size === 0 || actionInProgress)
      return;
    if (commitLockRef.current) return;
    commitLockRef.current = true;
    setActionInProgress(selectedAction);

    const toUnstage = summaries.flatMap((file) =>
      file.staged && !checkedFiles.has(file.path) ? [file.path] : [],
    );
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

/**
 * Runs `clearInProgress` and then `onEnded(action)` when a workflow ends for
 * `commitProgressId`. Keyed on the store's per-thread `settled` counter, not on
 * the entry disappearing: an entry also "disappears" when the pane switches to
 * another thread, and a workflow that failed before it started never had one.
 * Switching threads only runs `clearInProgress` (the flags were the previous
 * thread's): nothing ended here, so no after-workflow refresh or auto-close.
 */
function useClearOnWorkflowEnd(
  commitProgressId: string,
  clearInProgress: () => void,
  onEnded: (action: string | undefined) => void,
): void {
  const settled = useCommitProgressStore((s) => s.settled[commitProgressId]);
  const lastSettledRef = useRef({ id: commitProgressId, count: settled?.count ?? 0 });
  const onSettledChange = useStableCallback(() => {
    const last = lastSettledRef.current;
    const count = settled?.count ?? 0;
    lastSettledRef.current = { id: commitProgressId, count };
    if (last.id !== commitProgressId) {
      clearInProgress();
      return;
    }
    if (count === last.count) return;
    clearInProgress();
    onEnded(settled?.action);
  });
  useEffect(() => {
    onSettledChange();
  }, [commitProgressId, settled, onSettledChange]);
}
