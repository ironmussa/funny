import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { SettingsPanel } from './SettingsPanel';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AddProjectForm } from './sidebar/AddProjectForm';
import { AutomationInboxButton } from './sidebar/AutomationInboxButton';
import { RunningThreads } from './sidebar/RunningThreads';
import { RecentThreads } from './sidebar/RecentThreads';
import { ProjectItem } from './sidebar/ProjectItem';

export function Sidebar() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const projects = useAppStore(s => s.projects);
  const threadsByProject = useAppStore(s => s.threadsByProject);
  const selectedThreadId = useAppStore(s => s.selectedThreadId);
  const expandedProjects = useAppStore(s => s.expandedProjects);
  const toggleProject = useAppStore(s => s.toggleProject);
  const loadProjects = useAppStore(s => s.loadProjects);
  const startNewThread = useAppStore(s => s.startNewThread);
  const archiveThread = useAppStore(s => s.archiveThread);
  const deleteThread = useAppStore(s => s.deleteThread);
  const deleteProject = useAppStore(s => s.deleteProject);
  const settingsOpen = useAppStore(s => s.settingsOpen);
  const showAllThreads = useAppStore(s => s.showAllThreads);

  const [archiveConfirm, setArchiveConfirm] = useState<{
    threadId: string;
    projectId: string;
    title: string;
    isWorktree?: boolean;
  } | null>(null);
  const [deleteThreadConfirm, setDeleteThreadConfirm] = useState<{
    threadId: string;
    projectId: string;
    title: string;
    isWorktree?: boolean;
  } | null>(null);
  const [deleteProjectConfirm, setDeleteProjectConfirm] = useState<{
    projectId: string;
    name: string;
  } | null>(null);

  const handleArchiveConfirm = useCallback(async () => {
    if (!archiveConfirm) return;
    const { threadId, projectId } = archiveConfirm;
    const wasSelected = selectedThreadId === threadId;
    await archiveThread(threadId, projectId);
    setArchiveConfirm(null);
    toast.success(t('toast.threadArchived'));
    if (wasSelected) navigate(`/projects/${projectId}`);
  }, [archiveConfirm, selectedThreadId, archiveThread, navigate, t]);

  const handleDeleteThreadConfirm = useCallback(async () => {
    if (!deleteThreadConfirm) return;
    const { threadId, projectId, title } = deleteThreadConfirm;
    const wasSelected = selectedThreadId === threadId;
    await deleteThread(threadId, projectId);
    setDeleteThreadConfirm(null);
    toast.success(t('toast.threadDeleted', { title }));
    if (wasSelected) navigate(`/projects/${projectId}`);
  }, [deleteThreadConfirm, selectedThreadId, deleteThread, navigate, t]);

  const handleDeleteProjectConfirm = useCallback(async () => {
    if (!deleteProjectConfirm) return;
    const { projectId, name } = deleteProjectConfirm;
    await deleteProject(projectId);
    setDeleteProjectConfirm(null);
    toast.success(t('toast.projectDeleted', { name }));
    navigate('/');
  }, [deleteProjectConfirm, deleteProject, navigate, t]);

  if (settingsOpen) {
    return <SettingsPanel />;
  }

  return (
    <div className="flex flex-col h-full">
      <AddProjectForm />
      {/* Active threads + Project accordion list */}
      <ScrollArea className="flex-1 px-2 pb-2">
        <AutomationInboxButton />
        <h2 className="px-2 pt-2 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('sidebar.threadsTitle')}</h2>
        <RunningThreads />
        <RecentThreads
          onArchiveThread={(threadId, projectId, title, isWorktree) => {
            setArchiveConfirm({ threadId, projectId, title, isWorktree });
          }}
          onDeleteThread={(threadId, projectId, title, isWorktree) => {
            setDeleteThreadConfirm({ threadId, projectId, title, isWorktree });
          }}
        />
        {projects.map((project) => (
          <ProjectItem
            key={project.id}
            project={project}
            threads={threadsByProject[project.id] ?? []}
            isExpanded={expandedProjects.has(project.id)}
            selectedThreadId={selectedThreadId}
            onToggle={() => {
              const wasExpanded = expandedProjects.has(project.id);
              toggleProject(project.id);
              if (wasExpanded) {
                navigate('/');
              } else {
                // Fetch git statuses for worktree threads when expanding
                useGitStatusStore.getState().fetchForProject(project.id);
                const projectThreads = threadsByProject[project.id];
                if (projectThreads && projectThreads.length > 0) {
                  navigate(`/projects/${project.id}/threads/${projectThreads[0].id}`);
                } else {
                  navigate(`/projects/${project.id}`);
                }
              }
            }}
            onNewThread={() => {
              startNewThread(project.id);
              navigate(`/projects/${project.id}`);
            }}
            onDeleteProject={() => {
              setDeleteProjectConfirm({ projectId: project.id, name: project.name });
            }}
            onSelectThread={(threadId) => {
              const store = useAppStore.getState();
              // If already on this thread's URL but activeThread didn't load, re-select directly
              if (store.selectedThreadId === threadId && (!store.activeThread || store.activeThread.id !== threadId)) {
                store.selectThread(threadId);
              }
              navigate(`/projects/${project.id}/threads/${threadId}`);
            }}
            onArchiveThread={(threadId, title) => {
              const threads = threadsByProject[project.id] ?? [];
              const th = threads.find(t => t.id === threadId);
              setArchiveConfirm({ threadId, projectId: project.id, title, isWorktree: th?.mode === 'worktree' && !!th?.branch });
            }}
            onDeleteThread={(threadId, title) => {
              const threads = threadsByProject[project.id] ?? [];
              const th = threads.find(t => t.id === threadId);
              setDeleteThreadConfirm({ threadId, projectId: project.id, title, isWorktree: th?.mode === 'worktree' && !!th?.branch });
            }}
            onShowAllThreads={() => {
              showAllThreads(project.id);
              navigate(`/projects/${project.id}/threads`);
            }}
          />
        ))}
      </ScrollArea>

      {/* Archive confirmation dialog */}
      <Dialog
        open={!!archiveConfirm}
        onOpenChange={(open) => { if (!open) setArchiveConfirm(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.archiveThread')}</DialogTitle>
            <DialogDescription>
              {t('dialog.archiveThreadDesc', { title: archiveConfirm?.title })}
            </DialogDescription>
          </DialogHeader>
          {archiveConfirm?.isWorktree && (
            <p className="text-xs text-amber-500 bg-amber-500/10 rounded-md px-3 py-2">
              {t('dialog.worktreeWarning')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setArchiveConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleArchiveConfirm}>
              {t('sidebar.archive')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete thread confirmation dialog */}
      <Dialog
        open={!!deleteThreadConfirm}
        onOpenChange={(open) => { if (!open) setDeleteThreadConfirm(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.deleteThread')}</DialogTitle>
            <DialogDescription>
              {t('dialog.deleteThreadDesc', { title: deleteThreadConfirm?.title })}
            </DialogDescription>
          </DialogHeader>
          {deleteThreadConfirm?.isWorktree && (
            <p className="text-xs text-amber-500 bg-amber-500/10 rounded-md px-3 py-2">
              {t('dialog.worktreeWarning')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteThreadConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDeleteThreadConfirm}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete project confirmation dialog */}
      <Dialog
        open={!!deleteProjectConfirm}
        onOpenChange={(open) => { if (!open) setDeleteProjectConfirm(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.deleteProject')}</DialogTitle>
            <DialogDescription>
              {t('dialog.deleteProjectDesc', { name: deleteProjectConfirm?.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteProjectConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDeleteProjectConfirm}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
