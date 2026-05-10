import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type {
  ArchiveConfirmState,
  DeleteProjectConfirmState,
  DeleteThreadConfirmState,
  RenameProjectState,
} from '@/components/sidebar/SidebarDialogs';
import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { api } from '@/lib/api';
import { buildPath } from '@/lib/url';
import { resolveThreadBranch } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

/**
 * Owns the sidebar's destructive-action confirmation state and all the row
 * handlers (select/archive/delete/rename/pin) that ProjectItem and ThreadList
 * receive as props. Bundling them in a hook keeps Sidebar.tsx free of the
 * `toast`, `api`, `use-branch-switch`, and `resolveThreadBranch` imports
 * (~3-4 fan-out edges).
 */
export function useSidebarActions() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const { ensureBranch, branchSwitchDialog } = useBranchSwitch();
  const archiveThread = useThreadStore((s) => s.archiveThread);
  const renameThread = useThreadStore((s) => s.renameThread);
  const pinThread = useThreadStore((s) => s.pinThread);
  const deleteThread = useThreadStore((s) => s.deleteThread);
  const renameProject = useProjectStore((s) => s.renameProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const closeProject = useProjectStore((s) => s.closeProject);
  const reopenProject = useProjectStore((s) => s.reopenProject);

  const [archiveConfirm, setArchiveConfirm] = useState<ArchiveConfirmState | null>(null);
  const [deleteThreadConfirm, setDeleteThreadConfirm] = useState<DeleteThreadConfirmState | null>(
    null,
  );
  const [renameProjectState, setRenameProjectState] = useState<RenameProjectState | null>(null);
  const [deleteProjectConfirm, setDeleteProjectConfirm] =
    useState<DeleteProjectConfirmState | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [issuesProjectId, setIssuesProjectId] = useState<string | null>(null);

  const handleArchiveConfirm = useCallback(async () => {
    if (!archiveConfirm) return;
    setActionLoading(true);
    const { threadId, projectId } = archiveConfirm;
    const wasSelected = useThreadStore.getState().selectedThreadId === threadId;
    await archiveThread(threadId, projectId);
    setActionLoading(false);
    setArchiveConfirm(null);
    toast.success(t('toast.threadArchived'));
    if (wasSelected) navigate(buildPath(`/projects/${projectId}`));
  }, [archiveConfirm, archiveThread, t, navigate]);

  const handleDeleteThreadConfirm = useCallback(
    async (options?: { deleteBranch?: boolean }) => {
      if (!deleteThreadConfirm) return;
      const { threadId, projectId, title, worktreePath, branchName } = deleteThreadConfirm;
      const wasSelected = useThreadStore.getState().selectedThreadId === threadId;

      // Close the modal up-front. deleteThread is already optimistic (sync UI
      // updates + fire-and-forget API), so showing a loading spinner mid-exit
      // animation makes the button content swap during the fade-out and reads
      // as a flicker.
      setDeleteThreadConfirm(null);

      if (options?.deleteBranch && worktreePath && branchName) {
        await api.removeWorktree(projectId, worktreePath, {
          branchName,
          deleteBranch: true,
        });
      }

      await deleteThread(threadId, projectId);
      toast.success(t('toast.threadDeleted', { title }));
      if (wasSelected) navigate(buildPath(`/projects/${projectId}`));
    },
    [deleteThreadConfirm, deleteThread, t, navigate],
  );

  const handleRenameProjectConfirm = useCallback(async () => {
    if (!renameProjectState) return;
    const { projectId, newName } = renameProjectState;
    if (!newName.trim()) {
      toast.error('Project name cannot be empty');
      return;
    }
    setActionLoading(true);
    try {
      await renameProject(projectId, newName.trim());
      setRenameProjectState(null);
      toast.success(t('toast.projectRenamed', { name: newName.trim() }));
    } catch (error: any) {
      toast.error(error.message || 'Failed to rename project');
    } finally {
      setActionLoading(false);
    }
  }, [renameProjectState, renameProject, t]);

  const handleDeleteProjectConfirm = useCallback(async () => {
    if (!deleteProjectConfirm) return;
    const { projectId, name } = deleteProjectConfirm;
    setDeleteProjectConfirm(null);
    await deleteProject(projectId);
    toast.success(t('toast.projectDeleted', { name }));
    navigate(buildPath('/'));
  }, [deleteProjectConfirm, deleteProject, t, navigate]);

  const handleSelectThread = useCallback(
    async (projectId: string, threadId: string) => {
      const threads = useThreadStore.getState().threadsByProject[projectId] ?? [];
      const thread = threads.find((th) => th.id === threadId);
      if (thread?.mode === 'local') {
        const branch = resolveThreadBranch(thread);
        if (branch) {
          const canProceed = await ensureBranch(projectId, branch);
          if (!canProceed) return;
        }
      }

      const store = useThreadStore.getState();
      if (
        store.selectedThreadId === threadId &&
        (!store.activeThread || store.activeThread.id !== threadId)
      ) {
        store.selectThread(threadId);
      }
      navigate(buildPath(`/projects/${projectId}/threads/${threadId}`));
    },
    [navigate, ensureBranch],
  );

  const handleArchiveThread = useCallback((projectId: string, threadId: string, title: string) => {
    const threads = useThreadStore.getState().threadsByProject[projectId] ?? [];
    const th = threads.find((t) => t.id === threadId);
    setArchiveConfirm({
      threadId,
      projectId,
      title,
      isWorktree: th?.mode === 'worktree' && !!th?.branch && th?.provider !== 'external',
    });
  }, []);

  const handleRenameThread = useCallback(
    (projectId: string, threadId: string, newTitle: string) => {
      renameThread(threadId, projectId, newTitle);
    },
    [renameThread],
  );

  const handlePinThread = useCallback(
    (projectId: string, threadId: string, pinned: boolean) => {
      pinThread(threadId, projectId, pinned);
    },
    [pinThread],
  );

  const handleDeleteThread = useCallback((projectId: string, threadId: string, title: string) => {
    const threads = useThreadStore.getState().threadsByProject[projectId] ?? [];
    const th = threads.find((t) => t.id === threadId);
    const isWorktree = th?.mode === 'worktree' && !!th?.branch && th?.provider !== 'external';
    setDeleteThreadConfirm({
      threadId,
      projectId,
      title,
      isWorktree,
      worktreePath: isWorktree ? th?.worktreePath : undefined,
      branchName: isWorktree ? th?.branch : undefined,
    });
  }, []);

  const handleArchiveThreadFromList = useCallback(
    (threadId: string, projectId: string, title: string, isWorktree: boolean) => {
      setArchiveConfirm({ threadId, projectId, title, isWorktree });
    },
    [],
  );

  const handleDeleteThreadFromList = useCallback(
    (threadId: string, projectId: string, title: string, isWorktree: boolean) => {
      const threads = useThreadStore.getState().threadsByProject[projectId] ?? [];
      const th = threads.find((t) => t.id === threadId);
      setDeleteThreadConfirm({
        threadId,
        projectId,
        title,
        isWorktree,
        worktreePath: isWorktree ? th?.worktreePath : undefined,
        branchName: isWorktree ? th?.branch : undefined,
      });
    },
    [],
  );

  const handleRenameProject = useCallback((projectId: string, currentName: string) => {
    setRenameProjectState({ projectId, currentName, newName: currentName });
  }, []);

  const handleDeleteProject = useCallback((projectId: string, name: string) => {
    setDeleteProjectConfirm({ projectId, name });
  }, []);

  const handleCloseProject = useCallback(
    async (projectId: string, name: string) => {
      const wasSelected = useProjectStore.getState().selectedProjectId === projectId;
      await closeProject(projectId);
      toast.success(t('toast.projectClosed', { name }));
      if (wasSelected) navigate(buildPath('/'));
    },
    [closeProject, t, navigate],
  );

  const handleReopenProject = useCallback(
    async (projectId: string, name: string) => {
      await reopenProject(projectId);
      toast.success(t('toast.projectReopened', { name }));
    },
    [reopenProject, t],
  );

  const handleShowIssues = useCallback((projectId: string) => {
    setIssuesProjectId(projectId);
  }, []);

  return {
    // confirm state + setters (passed to SidebarDialogs)
    archiveConfirm,
    setArchiveConfirm,
    deleteThreadConfirm,
    setDeleteThreadConfirm,
    renameProjectState,
    setRenameProjectState,
    deleteProjectConfirm,
    setDeleteProjectConfirm,
    actionLoading,
    issuesProjectId,
    setIssuesProjectId,

    // confirm handlers
    handleArchiveConfirm,
    handleDeleteThreadConfirm,
    handleRenameProjectConfirm,
    handleDeleteProjectConfirm,

    // row handlers
    handleSelectThread,
    handleArchiveThread,
    handleArchiveThreadFromList,
    handleRenameThread,
    handlePinThread,
    handleDeleteThread,
    handleDeleteThreadFromList,
    handleRenameProject,
    handleDeleteProject,
    handleCloseProject,
    handleReopenProject,
    handleShowIssues,

    // branch switch dialog (rendered by parent)
    branchSwitchDialog,
  };
}
