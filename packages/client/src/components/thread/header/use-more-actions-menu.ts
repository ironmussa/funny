import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { useTooltipMenu } from '@/hooks/use-tooltip-menu';
import { api } from '@/lib/api';
import * as variant from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { resolveThreadBranch } from '@/lib/utils';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { useProjectStore } from '@/stores/project-store';
import { type Editor } from '@/stores/settings-store';
import {
  getThreadById,
  useThreadId,
  useThreadProjectId,
  useThreadSelector,
  useThreadStatus,
  useThreadWorktreePath,
} from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { threadToMarkdown } from './thread-to-markdown';

/**
 * Owns the state, store reads, and async handlers for MoreActionsMenu so the
 * component file stays under the 150-line lint limit and the JSX has only
 * presentational concerns.
 */
export function useMoreActionsMenu() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const threadId = useThreadId();
  const threadProjectId = useThreadProjectId();
  const threadTitle = useThreadSelector((tt) => tt?.title);
  const threadMode = useThreadSelector((tt) => tt?.mode);
  const threadBranch = useThreadSelector((tt) => (tt ? resolveThreadBranch(tt) : undefined));
  const threadPinned = useThreadSelector((tt) => tt?.pinned);
  const threadStage = useThreadSelector((tt) => tt?.stage);
  const threadWorktreePath = useThreadWorktreePath();
  const isScratchThread = useThreadSelector((tt) => variant.isScratch(tt));
  const hasMessages = useThreadSelector((tt) => (tt?.messages?.length ?? 0) > 0);
  const threadStatus = useThreadStatus();
  const pinThread = useThreadStore((s) => s.pinThread);
  const updateThreadStage = useThreadStore((s) => s.updateThreadStage);
  const deleteScratchThread = useThreadStore((s) => s.deleteScratchThread);
  const menuSelectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const project = useProjectStore((s) =>
    threadProjectId ? s.projects.find((p) => p.id === threadProjectId) : undefined,
  );
  const projectBranch = useProjectStore((s) =>
    threadProjectId ? s.branchByProject[threadProjectId] : undefined,
  );
  const timelineVisible = useUIStore((s) => s.timelineVisible);
  const setTimelineVisible = useUIStore((s) => s.setTimelineVisible);
  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);
  const setActivityPaneOpen = useUIStore((s) => s.setActivityPaneOpen);
  const activityActive = reviewPaneOpen && rightPaneTab === 'activity';
  const browserPanelOpen = useBrowserPanelStore((s) => s.open);
  const toggleBrowserPanel = useBrowserPanelStore((s) => s.togglePanel);

  const [copiedText, copyText] = useCopyToClipboard();
  const [copiedTools, copyTools] = useCopyToClipboard();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [createBranchLoading, setCreateBranchLoading] = useState(false);

  const isWorktree = threadMode === 'worktree' && !!threadBranch;
  const isBusy = threadStatus === 'running' || threadStatus === 'setting_up';
  const canConvertToWorktree =
    useThreadSelector((tt) => variant.canConvertToWorktree(tt)) && !isBusy;
  const sourceBranch = threadBranch || projectBranch;
  const canShowBrowserPanel = !!menuSelectedProjectId && !isScratchThread;
  const showStage = !!threadId && !!threadStage && threadStage !== 'archived' && !isScratchThread;

  const tooltipMenu = useTooltipMenu();

  const handleConvertToWorktree = useCallback(async () => {
    if (!threadId) return;
    const result = await api.convertToWorktree(threadId);
    if (result.isErr()) {
      toast.error(String(result.error));
    } else {
      toast.success(t('toast.convertToWorktreeStarted'));
    }
  }, [threadId, t]);

  const handleCreateBranch = useCallback(
    async (name: string) => {
      if (!name || !threadProjectId) return;
      setCreateBranchLoading(true);
      const result = await api.checkout(threadProjectId, name, 'carry', true, threadId);
      setCreateBranchLoading(false);
      if (result.isErr()) {
        toast.error(String(result.error));
      } else {
        setCreateBranchOpen(false);
      }
    },
    [threadProjectId, threadId],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!threadId) return;
    const thread = getThreadById(threadId);
    if (!thread) return;
    const title = thread.title;
    setDeleteLoading(true);
    if (variant.isScratch(thread)) {
      await deleteScratchThread(threadId);
      setDeleteLoading(false);
      setDeleteOpen(false);
      toast.success(t('toast.threadDeleted', { title }));
      navigate(buildPath('/'));
      return;
    }
    const projId = thread.projectId;
    if (!projId) {
      setDeleteLoading(false);
      return;
    }
    await useThreadStore.getState().deleteThread(threadId, projId);
    setDeleteLoading(false);
    setDeleteOpen(false);
    toast.success(t('toast.threadDeleted', { title }));
    navigate(buildPath(`/projects/${projId}`));
  }, [deleteScratchThread, navigate, t, threadId]);

  const handleCopy = useCallback(
    (includeToolCalls: boolean) => {
      if (!threadId) return;
      const messages = getThreadById(threadId)?.messages;
      if (!messages?.length) return;
      const md = threadToMarkdown(messages, includeToolCalls);
      if (includeToolCalls) {
        copyTools(md);
      } else {
        copyText(md);
      }
    },
    [copyText, copyTools, threadId],
  );

  const handleOpenInEditor = useCallback(
    async (editor: Editor) => {
      if (!project) return;
      const folderPath = threadWorktreePath || project.path;
      const result = await api.openInEditor(folderPath, editor);
      if (result.isErr()) {
        toast.error(t('sidebar.openInEditorError', 'Failed to open in editor'));
      }
    },
    [project, threadWorktreePath, t],
  );

  const togglePin = useCallback(() => {
    if (!threadId || !threadProjectId) return;
    const next = !threadPinned;
    pinThread(threadId, threadProjectId, next);
    toast.success(
      next
        ? t('toast.threadPinned', 'Thread pinned')
        : t('toast.threadUnpinned', 'Thread unpinned'),
    );
  }, [pinThread, t, threadId, threadProjectId, threadPinned]);

  const toggleActivity = useCallback(() => {
    setActivityPaneOpen(!activityActive);
  }, [activityActive, setActivityPaneOpen]);

  const toggleTimeline = useCallback(() => {
    setTimelineVisible(!timelineVisible);
  }, [timelineVisible, setTimelineVisible]);

  const toggleBrowser = useCallback(() => {
    toggleBrowserPanel();
  }, [toggleBrowserPanel]);

  const handleViewOnBoard = useCallback(() => {
    if (!threadId || !threadProjectId) return;
    setReviewPaneOpen(false);
    navigate(buildPath(`/kanban?project=${threadProjectId}&highlight=${threadId}`));
  }, [navigate, setReviewPaneOpen, threadId, threadProjectId]);

  const handleStageChange = useCallback(
    (stage: NonNullable<typeof threadStage>) => {
      if (!threadId || !threadProjectId) return;
      updateThreadStage(threadId, threadProjectId, stage);
    },
    [threadId, threadProjectId, updateThreadStage],
  );

  return {
    threadId,
    threadProjectId,
    threadTitle,
    threadStage,
    hasMessages,
    isWorktree,
    isScratchThread,
    canConvertToWorktree,
    canShowBrowserPanel,
    showStage,
    threadPinned,
    sourceBranch,
    activityActive,
    timelineVisible,
    browserPanelOpen,
    copiedText,
    copiedTools,
    deleteOpen,
    setDeleteOpen,
    deleteLoading,
    createBranchOpen,
    setCreateBranchOpen,
    createBranchLoading,
    tooltipMenu,
    handleConvertToWorktree,
    handleCreateBranch,
    handleDeleteConfirm,
    handleCopy,
    handleOpenInEditor,
    handleStageChange,
    handleViewOnBoard,
    togglePin,
    toggleActivity,
    toggleTimeline,
    toggleBrowser,
  };
}
