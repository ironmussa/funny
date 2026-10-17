import type { FileDiffSummary } from '@funny/shared';
import { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { resolveBasePath } from '@/components/review-pane/resolve-base-path';
import { useReviewState } from '@/hooks/use-review-state';
import { useRightPaneProjectId, useRightPaneThreadId } from '@/hooks/use-right-pane-target';
import { useThreadById } from '@/lib/thread-selectors';
import { canLoadGitHistory } from '@/lib/thread-variant';
import { resolveThreadBranch } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { useGitStatusStore, useGitStatusForThread } from '@/stores/git-status-store';
import { usePRDetail } from '@/stores/pr-detail-store';
import { useProjectStore } from '@/stores/project-store';
import {
  useThreadProjectId,
  useThreadSelector,
  useThreadStatus,
  useThreadWorktreePath,
} from '@/stores/thread-context';
import { useUIStore, type ReviewSubTab } from '@/stores/ui-store';

import { expandedFileIcon } from './review-pane-props';
import type { ConfirmDialogState } from './ReviewDialogs';

/**
 * The review pane's state model, shared by `ReviewPane` (single panel) and
 * `ReviewPaneStateProvider` (dockview panels): what the pane is looking at
 * (thread vs project mode, git context, base path, branches, git status), the
 * aggregated review state, URL sub-tab sync and the expanded-diff overlay.
 */

type LightThread = ReturnType<typeof useThreadById>;

/**
 * Git identity of the targeted thread (`null` in project mode). Prefers the
 * heavy thread data, falling back to the lightweight sidebar index.
 */
function resolveGitThread(
  effectiveThreadId: string | undefined,
  threadProjectId: string | undefined,
  threadIsScratch: boolean | undefined,
  lightThread: LightThread,
) {
  if (!effectiveThreadId) return null;
  return {
    projectId: threadProjectId ?? lightThread?.projectId ?? '',
    isScratch: threadIsScratch ?? lightThread?.isScratch,
  };
}

function buildGitContextKey(
  effectiveThreadId: string | undefined,
  projectModeId: string | null,
  targetProjectId: string | null | undefined,
): string {
  return `${effectiveThreadId || projectModeId || ''}::${targetProjectId ?? ''}`;
}

// `useThreadWorktreePath` / `useThreadProjectId` read the heavy `threadDataById`
// map, which loads ~1-2s AFTER `selectedThreadId` flips on click. During that
// window — or when a thread is opened without a project selected in the sidebar
// (Activity / All-threads / direct URL) — both are undefined and basePath would
// collapse to '', so file-open actions sent a repo-relative path that 404s
// against `/files/read` (which needs an absolute path). The lightweight
// `threadsById` index (sidebar) always carries projectId + worktreePath for the
// selected thread, so use it as an immediate fallback.
function useReviewBasePath(
  lightThread: LightThread,
  threadProjectId: string | undefined,
  selectedProjectId: string | null,
): string {
  const worktreePath = useThreadWorktreePath();
  const projectsForPath = useProjectStore((s) => s.projects);
  return useMemo(
    () =>
      resolveBasePath({
        worktreePath,
        lightThread,
        threadProjectId,
        selectedProjectId,
        projects: projectsForPath,
      }),
    [worktreePath, lightThread, threadProjectId, selectedProjectId, projectsForPath],
  );
}

/** Which thread / project the right pane targets and its git context. */
function useReviewGitTarget() {
  const selectedProjectId = useRightPaneProjectId();

  // selectedThreadId updates immediately on thread click (before the thread
  // data loads), so git fetches start ~1-2s sooner than waiting for activeThread.
  // In the grid view this follows the grid-selected thread instead.
  const selectedThreadId = useRightPaneThreadId();
  const effectiveThreadId = selectedThreadId || undefined;
  const projectModeId = !effectiveThreadId ? selectedProjectId : null;

  const threadProjectId = useThreadProjectId();
  const lightThread = useThreadById(selectedThreadId ?? undefined);
  const threadIsScratch = useThreadSelector((t) => t?.isScratch);
  const gitThread = resolveGitThread(
    effectiveThreadId,
    threadProjectId,
    threadIsScratch,
    lightThread,
  );
  const hasGitContext = !!projectModeId || canLoadGitHistory(gitThread);
  // The project whose git state backs the pane: the selected project in
  // project mode, otherwise the active thread's project (worktrees share git
  // config with the project).
  const targetProjectId = projectModeId ?? gitThread?.projectId;
  const basePath = useReviewBasePath(lightThread, threadProjectId, selectedProjectId);

  return {
    selectedProjectId,
    effectiveThreadId,
    projectModeId,
    threadProjectId,
    targetProjectId,
    hasGitContext,
    gitContextKey: buildGitContextKey(effectiveThreadId, projectModeId, targetProjectId),
    basePath,
  };
}

/**
 * A non-owner viewer (a `steer` sharee — `view` sharees can't open the pane)
 * gets a read-only review pane: git writes are owner-only (thread-sharing-steer).
 */
function useViewerReadOnly(): boolean {
  const selfUserId = useAuthStore((s) => s.user?.id ?? null);
  const threadOwnerId = useThreadSelector((t) => t?.userId ?? null);
  return !!selfUserId && !!threadOwnerId && threadOwnerId !== selfUserId;
}

function useReviewBranches(targetProjectId: string | null | undefined) {
  const isWorktree = useThreadSelector((t) => t?.mode === 'worktree');
  const baseBranch = useThreadSelector((t) => t?.baseBranch);
  // Worktree threads track their own branch; local threads share the project's
  // working directory, so their "current branch" is the project's branch.
  const threadBranch = useThreadSelector((t) => {
    if (!t) return undefined;
    if (t.mode !== 'worktree') return undefined;
    return resolveThreadBranch(t);
  });
  const projectBranch = useProjectStore((s) =>
    targetProjectId ? s.branchByProject[targetProjectId] : undefined,
  );
  return { isWorktree, baseBranch, threadBranch, currentBranch: threadBranch || projectBranch };
}

function useReviewGitStatus(effectiveThreadId: string | undefined, projectModeId: string | null) {
  const threadGitStatus = useGitStatusForThread(effectiveThreadId);
  const projectGitStatus = useGitStatusStore((s) =>
    projectModeId ? s.statusByProject[projectModeId] : undefined,
  );
  return threadGitStatus ?? projectGitStatus;
}

function deriveGitStatusFields(
  gitStatus: ReturnType<typeof useReviewGitStatus>,
  targetProjectId: string | null | undefined,
) {
  return {
    /** Project id for PR / CI lookups ('' when there is none). */
    projectId: targetProjectId ?? '',
    prNumber: gitStatus?.prNumber ?? undefined,
    prUrl: gitStatus?.prUrl ?? undefined,
    unpushedCommitCount: gitStatus?.unpushedCommitCount ?? 0,
    // remoteCheckProjectId resolves either the project-mode id or the active
    // thread's project (worktrees share git config with the project).
    remoteCheckProjectId: targetProjectId ?? null,
  };
}

/** Everything the review pane needs to know about its target. */
function useReviewPaneTarget() {
  const target = useReviewGitTarget();
  const viewerReadOnly = useViewerReadOnly();
  const branches = useReviewBranches(target.targetProjectId);
  const isAgentRunning = useThreadStatus() === 'running';
  const gitStatus = useReviewGitStatus(target.effectiveThreadId, target.projectModeId);
  const statusFields = deriveGitStatusFields(gitStatus, target.targetProjectId);
  const { threads: prThreads } = usePRDetail(
    statusFields.projectId || undefined,
    statusFields.prNumber,
  );
  return {
    ...target,
    ...branches,
    ...statusFields,
    viewerReadOnly,
    isAgentRunning,
    gitStatus,
    prThreads,
  };
}

/** Sets the active review sub-tab and mirrors it into the `?tab=` query param. */
function useReviewSubTabNavigation() {
  const navigate = useNavigate();
  const { pathname, search: locationSearch } = useLocation();
  const setReviewSubTabStore = useUIStore((s) => s.setReviewSubTab);
  return useCallback(
    (tab: ReviewSubTab) => {
      setReviewSubTabStore(tab);
      const params = new URLSearchParams(locationSearch);
      if (tab === 'changes') {
        params.delete('tab');
      } else {
        params.set('tab', tab);
      }
      const search = params.toString();
      navigate(`${pathname}${search ? `?${search}` : ''}`, { replace: true });
    },
    [setReviewSubTabStore, pathname, locationSearch, navigate],
  );
}

/**
 * The toolbar's ⟳ button: `refresh` (from the review hook) only reloads the
 * file diffs — it does NOT re-fetch the unpushed/unpulled counts. So the sync
 * badges stay a stale snapshot (e.g. unpushed shows 5 but unpulled stays 0
 * even after origin advanced). Compose a refresh that ALSO force-fetches git
 * status so clicking refresh updates the badges, mirroring what pull/fetch do.
 */
function useRefreshAll({
  effectiveThreadId,
  projectModeId,
  threadProjectId,
  refresh,
}: {
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  threadProjectId: string | undefined;
  refresh: () => Promise<void> | void;
}) {
  return useCallback(async () => {
    const gitStore = useGitStatusStore.getState();
    if (effectiveThreadId) {
      void gitStore.fetchForThread(effectiveThreadId, true);
      if (threadProjectId) void gitStore.fetchForProject(threadProjectId, true);
    } else if (projectModeId) {
      void gitStore.fetchProjectStatus(projectModeId, true);
      void gitStore.fetchForProject(projectModeId, true);
    }
    await refresh();
  }, [effectiveThreadId, projectModeId, threadProjectId, refresh]);
}

/**
 * Props for the expanded-diff overlay, computed once per render. The select /
 * close callbacks are stable to avoid re-rendering ExpandedDiffView.
 */
function useExpandedDiff({
  expandedFile,
  setExpandedFile,
  setSelectedFile,
  loadDiffForFile,
  summaries,
  diffCache,
}: {
  expandedFile: string | null;
  setExpandedFile: (path: string | null) => void;
  setSelectedFile: (path: string | null) => void;
  loadDiffForFile: (path: string) => Promise<void>;
  summaries: FileDiffSummary[];
  diffCache: Map<string, string>;
}) {
  const onFileSelect = useCallback(
    (path: string) => {
      setExpandedFile(path);
      setSelectedFile(path);
      loadDiffForFile(path);
    },
    [loadDiffForFile, setExpandedFile, setSelectedFile],
  );

  const onClose = useCallback(() => setExpandedFile(null), [setExpandedFile]);

  const summary = expandedFile ? summaries.find((s) => s.path === expandedFile) : undefined;
  const diffContent = expandedFile ? diffCache.get(expandedFile) : undefined;
  return { onFileSelect, onClose, summary, diffContent, Icon: expandedFileIcon(summary) };
}

/**
 * The whole review-pane state: target resolution, UI-store flags, the
 * aggregated review state (8 hooks + selection state + lifecycle effects),
 * the confirm dialog, refresh/sub-tab actions and the expanded-diff overlay.
 */
export function useReviewPaneModel() {
  // ── Stores ──
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const reviewSubTab = useUIStore((s) => s.reviewSubTab);

  const target = useReviewPaneTarget();

  // ── UI-local state (orchestrator-only) ──
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  const review = useReviewState({
    effectiveThreadId: target.effectiveThreadId,
    projectModeId: target.projectModeId,
    hasGitContext: target.hasGitContext,
    gitContextKey: target.gitContextKey,
    threadProjectId: target.threadProjectId,
    selectedProjectId: target.selectedProjectId,
    baseBranch: target.baseBranch,
    threadBranch: target.threadBranch,
    currentBranch: target.currentBranch,
    basePath: target.basePath,
    isAgentRunning: target.isAgentRunning,
    gitStatus: target.gitStatus,
    unpushedCommitCount: target.unpushedCommitCount,
    remoteCheckProjectId: target.remoteCheckProjectId,
    reviewPaneOpen,
    reviewSubTab,
    setReviewPaneOpen,
    setConfirmDialog,
  });

  const refreshAll = useRefreshAll({
    effectiveThreadId: target.effectiveThreadId,
    projectModeId: target.projectModeId,
    threadProjectId: target.threadProjectId,
    refresh: review.refresh,
  });

  // ── Sync active sub-tab with URL query param ──
  const setReviewSubTab = useReviewSubTabNavigation();

  const expanded = useExpandedDiff(review);

  return {
    ...target,
    reviewPaneOpen,
    reviewSubTab,
    setReviewPaneOpen,
    confirmDialog,
    setConfirmDialog,
    review,
    refreshAll,
    setReviewSubTab,
    expanded,
  };
}
