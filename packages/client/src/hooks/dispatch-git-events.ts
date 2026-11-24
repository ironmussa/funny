/**
 * Realtime git events: status snapshots, moved refs and git workflow progress.
 */

import type { GitRefsUpdatedChange, WSGitRefsUpdatedData } from '@funny/shared';

import {
  applyGitStatusEvent,
  fetchForProject,
  fetchForThread,
  fetchProjectStatus,
  markGitStatusStale,
} from '@/data/git-status/actions';
import { readGitStatusMaps } from '@/data/git-status/read';
import { fetchProjectBranches } from '@/data/projects/branches';
import { notifyGitHistoryChanged } from '@/lib/git-history-invalidation';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { getProjectIdForThread, getUrlThreadId } from '@/stores/thread-store-internals';
import { readActiveThreadView } from '@/stores/thread-view';

export function notifyReviewDirty(threadId: string): void {
  import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
    useReviewPaneStore.getState().notifyDirty(threadId);
  });
}

export function handleGitStatus(threadId: string, data: any): void {
  // Fresh server state; also makes the matching request caches stale.
  applyGitStatusEvent(data.statuses);
  // PR-lookup updates don't touch the working tree — refetching the diff
  // summary for them only repeats an expensive request.
  if (!data.prOnly) notifyReviewDirty(threadId);
}

export function handleGitRefsUpdated(threadId: string, data: WSGitRefsUpdatedData): void {
  // A background recompute on the runtime found that a value it served stale
  // has changed: refetch only the views named in `changed`.
  const changed = data.changed;
  if (changed && !changed.includes('status')) {
    refetchChangedGitViews(threadId, data.projectId, changed);
    return;
  }
  refetchGitStatusAfterRefsMoved(data.projectId);
}

function refetchChangedGitViews(
  threadId: string,
  projectId: string,
  changed: readonly GitRefsUpdatedChange[],
): void {
  // Thread-mode panes key on the thread id, project-mode panes on the project id.
  if (changed.includes('diff')) notifyReviewDirty(threadId || projectId);
  if (changed.includes('branches')) void fetchProjectBranches(projectId, { force: true });
  if (changed.includes('history')) notifyGitHistoryChanged(threadId || projectId);
}

function refetchGitStatusAfterRefsMoved(projectId: string): void {
  // A background `git fetch` advanced the remote-tracking refs (origin may
  // have new commits). Re-fetch status through the normal — now cache-fresh
  // — path so the incoming-commit count surfaces without a second manual
  // refresh. The store's staleness guard keeps a late stale response from
  // overwriting this fresh one.
  //
  // Refresh the bulk slice for the project that emitted the event. The
  // thread/project-mode slices are only relevant when that same project is
  // active; refreshing them for unrelated repositories created a second
  // startup wave and repeatedly recomputed the same active-thread status.
  // Mark the project's status stale so the bulk sidebar refetch isn't served from cache.
  markGitStatusStale([projectId]);
  const activeThreadId = getUrlThreadId() ?? useThreadStore.getState().selectedThreadId;
  const activeThreadProjectId = activeThreadId ? getProjectIdForThread(activeThreadId) : undefined;
  if (activeThreadId && activeThreadProjectId === projectId) {
    void fetchForThread(activeThreadId, true); // thread-mode pane
  }
  if (useProjectStore.getState().selectedProjectId === projectId) {
    void fetchProjectStatus(projectId, true); // project-mode pane slice
  }
  void fetchForProject(projectId); // sidebar bulk badges
}

/** Delay before a completed workflow's progress entry is closed, keyed by thread. */
const COMPLETED_WORKFLOW_CLOSE_MS = 1500;
const pendingWorkflowCloses = new Map<string, ReturnType<typeof setTimeout>>();

function cancelPendingWorkflowClose(threadId: string) {
  const timer = pendingWorkflowCloses.get(threadId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingWorkflowCloses.delete(threadId);
}

export function handleGitWorkflowProgress(threadId: string, data: any) {
  import('@/stores/commit-progress-store').then(({ useCommitProgressStore }) => {
    const store = useCommitProgressStore.getState();
    const { status: wfStatus, title, action, steps, workflowId } = data;
    const current = store.activeCommits[threadId]?.workflowId;
    if (workflowId && current && current !== workflowId) {
      if (pendingWorkflowCloses.has(threadId)) {
        // The entry is a finished run kept on screen for its close delay; this
        // event is a newer run's (one that failed during setup sends `failed`
        // without `started`). End the finished one now and handle this one.
        cancelPendingWorkflowClose(threadId);
        store.finishCommit(threadId, current);
      } else if (wfStatus !== 'started') {
        // An event of an earlier run (another one has started since): it must
        // not touch the current run's steps, its close timer, or open a
        // failure modal.
        return;
      }
    }

    if (wfStatus === 'started') {
      // A restart within the close delay must not be closed by the previous run's timer.
      cancelPendingWorkflowClose(threadId);
      store.startCommit(threadId, title, steps, action, workflowId);
    } else if (wfStatus === 'step_update') {
      store.replaceSteps(threadId, steps, workflowId);
    } else if (wfStatus === 'completed') {
      store.replaceSteps(threadId, steps, workflowId);
      cancelPendingWorkflowClose(threadId);
      const timer = setTimeout(() => {
        pendingWorkflowCloses.delete(threadId);
        store.finishCommit(threadId, workflowId, action);
      }, COMPLETED_WORKFLOW_CLOSE_MS);
      pendingWorkflowCloses.set(threadId, timer);
    } else if (wfStatus === 'failed') {
      cancelPendingWorkflowClose(threadId);
      store.replaceSteps(threadId, steps, workflowId);
      store.setFailedWorkflow({
        title: title || 'Git operation failed',
        steps: steps ?? [],
        action: action ?? '',
      });
      store.finishCommit(threadId, workflowId, action);
    }
  });

  if (data.status === 'completed' || data.status === 'failed') {
    import('@/stores/review-pane-store').then(({ useReviewPaneStore }) => {
      useReviewPaneStore.getState().notifyDirty(threadId);
    });
  }
  if (
    data.status === 'completed' &&
    (data.action === 'push' ||
      data.action === 'create-pr' ||
      data.action === 'commit-pr' ||
      data.action === 'commit-merge')
  ) {
    import('@/data/pull-requests/queries').then(({ invalidatePR }) => {
      const activeThread = readActiveThreadView(useThreadStore.getState());
      if (activeThread) {
        const gitStatus = readGitStatusMaps();
        const bk =
          gitStatus.threadToBranchKey[activeThread.id] ??
          `${activeThread.projectId}:${activeThread.branch ?? ''}`;
        const prNum = gitStatus.statusByBranch[bk]?.prNumber;
        if (prNum) {
          invalidatePR(activeThread.projectId, prNum);
        }
      }
    });
  }
}
