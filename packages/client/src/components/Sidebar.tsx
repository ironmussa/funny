import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';
import { useAuthStore } from '@/stores/auth-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { SettingsPanel } from './SettingsPanel';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FolderPlus, Columns3, BarChart3, PanelLeftClose, Settings } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { AutomationInboxButton } from './sidebar/AutomationInboxButton';
import { ThreadList } from './sidebar/ThreadList';
import { ProjectItem } from './sidebar/ProjectItem';
import { GeneralSettingsDialog } from './GeneralSettingsDialog';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

export function AppSidebar() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  // project-store
  const projects = useProjectStore(s => s.projects);
  const selectedProjectId = useProjectStore(s => s.selectedProjectId);
  const expandedProjects = useProjectStore(s => s.expandedProjects);
  const toggleProject = useProjectStore(s => s.toggleProject);
  const loadProjects = useProjectStore(s => s.loadProjects);
  const renameProject = useProjectStore(s => s.renameProject);
  const deleteProject = useProjectStore(s => s.deleteProject);
  const reorderProjects = useProjectStore(s => s.reorderProjects);
  // thread-store
  const threadsByProject = useThreadStore(s => s.threadsByProject);
  const selectedThreadId = useThreadStore(s => s.selectedThreadId);
  const archiveThread = useThreadStore(s => s.archiveThread);
  const pinThread = useThreadStore(s => s.pinThread);
  const deleteThread = useThreadStore(s => s.deleteThread);
  // ui-store
  const settingsOpen = useUIStore(s => s.settingsOpen);
  const startNewThread = useUIStore(s => s.startNewThread);
  const setAddProjectOpen = useUIStore(s => s.setAddProjectOpen);
  const showGlobalSearch = useUIStore(s => s.showGlobalSearch);
  const authMode = useAuthStore(s => s.mode);
  const authUser = useAuthStore(s => s.user);
  const logout = useAuthStore(s => s.logout);
  const { toggleSidebar } = useSidebar();

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
  const [renameProjectState, setRenameProjectState] = useState<{
    projectId: string;
    currentName: string;
    newName: string;
  } | null>(null);
  const [deleteProjectConfirm, setDeleteProjectConfirm] = useState<{
    projectId: string;
    name: string;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [generalSettingsOpen, setGeneralSettingsOpen] = useState(false);
  const projectsScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll projects list to selected project (e.g. after Ctrl+K)
  useEffect(() => {
    if (!selectedProjectId || !projectsScrollRef.current) return;
    const el = projectsScrollRef.current.querySelector(
      `[data-project-id="${selectedProjectId}"]`
    );
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedProjectId]);

  // Drag & drop: monitor for project reordering
  useEffect(() => {
    return monitorForElements({
      onDrop: ({ source, location }) => {
        const targets = location.current.dropTargets;
        if (!targets.length) return;
        if (source.data.type !== 'sidebar-project') return;

        const targetData = targets[0].data;
        if (targetData.type !== 'sidebar-project') return;

        const sourceId = source.data.projectId as string;
        const targetId = targetData.projectId as string;
        if (sourceId === targetId) return;

        const oldIndex = projects.findIndex((p) => p.id === sourceId);
        const newIndex = projects.findIndex((p) => p.id === targetId);
        if (oldIndex === -1 || newIndex === -1) return;

        // Reorder: move source to target's position
        const reordered = [...projects];
        const [moved] = reordered.splice(oldIndex, 1);
        reordered.splice(newIndex, 0, moved);
        reorderProjects(reordered.map((p) => p.id));
      },
    });
  }, [projects, reorderProjects]);

  const handleArchiveConfirm = useCallback(async () => {
    if (!archiveConfirm) return;
    setActionLoading(true);
    const { threadId, projectId } = archiveConfirm;
    const wasSelected = selectedThreadId === threadId;
    await archiveThread(threadId, projectId);
    setActionLoading(false);
    setArchiveConfirm(null);
    toast.success(t('toast.threadArchived'));
    if (wasSelected) navigate(`/projects/${projectId}`);
  }, [archiveConfirm, selectedThreadId, archiveThread, navigate, t]);

  const handleDeleteThreadConfirm = useCallback(async () => {
    if (!deleteThreadConfirm) return;
    setActionLoading(true);
    const { threadId, projectId, title } = deleteThreadConfirm;
    const wasSelected = selectedThreadId === threadId;
    await deleteThread(threadId, projectId);
    setActionLoading(false);
    setDeleteThreadConfirm(null);
    toast.success(t('toast.threadDeleted', { title }));
    if (wasSelected) navigate(`/projects/${projectId}`);
  }, [deleteThreadConfirm, selectedThreadId, deleteThread, navigate, t]);

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
    setActionLoading(true);
    const { projectId, name } = deleteProjectConfirm;
    await deleteProject(projectId);
    setActionLoading(false);
    setDeleteProjectConfirm(null);
    toast.success(t('toast.projectDeleted', { name }));
    navigate('/');
  }, [deleteProjectConfirm, deleteProject, navigate, t]);

  if (settingsOpen) {
    return <SettingsPanel />;
  }

  return (
    <Sidebar collapsible="offcanvas" className="select-none">
      {/* Header with collapse toggle */}
      <SidebarHeader className="px-3 py-2 flex-row items-center justify-between">
        <span className="text-sm font-semibold text-sidebar-foreground">funny</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={toggleSidebar}
              className="text-muted-foreground h-7 w-7"
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('sidebar.collapse', 'Collapse sidebar')}</TooltipContent>
        </Tooltip>
      </SidebarHeader>

      {/* Active threads section (own scroll) */}
      <div className="flex flex-col max-h-[40%] min-h-[5rem] shrink-0">
        <div className="px-2">
          <AutomationInboxButton />
        </div>
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('sidebar.threadsTitle')}</h2>
        </div>
        <div className="relative overflow-y-auto min-h-0 px-2 pb-2">
          <div className="sticky top-0 left-0 right-0 h-4 -mb-4 bg-gradient-to-b from-sidebar to-transparent pointer-events-none z-10" />
          <ThreadList
            onArchiveThread={(threadId, projectId, title, isWorktree) => {
              setArchiveConfirm({ threadId, projectId, title, isWorktree });
            }}
            onDeleteThread={(threadId, projectId, title, isWorktree) => {
              setDeleteThreadConfirm({ threadId, projectId, title, isWorktree });
            }}
          />
        </div>
      </div>

      {/* Projects header (fixed, outside scroll) */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('sidebar.projects')}</h2>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => {
                  localStorage.setItem('threadViewMode', 'board');
                  showGlobalSearch();
                  navigate('/search?view=board');
                }}
                className="text-muted-foreground"
              >
                <Columns3 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Kanban</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => navigate('/analytics')}
                className="text-muted-foreground"
              >
                <BarChart3 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('sidebar.analytics')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setAddProjectOpen(true)}
                className="text-muted-foreground"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('sidebar.addProject')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Projects list (fills remaining space, own scroll) */}
      <SidebarContent ref={projectsScrollRef} className="px-2 pb-2 relative">
        <div className="sticky top-0 left-0 right-0 h-4 -mb-4 bg-gradient-to-b from-sidebar to-transparent pointer-events-none z-10 shrink-0" />
        {projects.length === 0 && (
          <button
            onClick={() => setAddProjectOpen(true)}
            className="w-full text-left px-2 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            {t('sidebar.noProjects')}
          </button>
        )}
        <div className="flex flex-col gap-1.5">
          {projects.map((project) => (
            <ProjectItem
              key={project.id}
              project={project}
              threads={(threadsByProject[project.id] ?? []).filter((t) => !t.archived)}
              isExpanded={expandedProjects.has(project.id)}
              isSelected={selectedProjectId === project.id}
              selectedThreadId={selectedThreadId}
              onToggle={() => {
                const wasExpanded = expandedProjects.has(project.id);
                toggleProject(project.id);
                // Defer expensive work (API calls, navigation) so the browser can paint the toggle immediately
                setTimeout(() => {
                  if (!wasExpanded) {
                    // startNewThread → selectProject already triggers fetchForProject
                    startNewThread(project.id);
                    navigate(`/projects/${project.id}`);
                  } else if (selectedProjectId !== project.id) {
                    useGitStatusStore.getState().fetchForProject(project.id);
                    navigate(`/projects/${project.id}`);
                  }
                }, 0);
              }}
              onNewThread={() => {
                setTimeout(() => {
                  startNewThread(project.id);
                  navigate(`/projects/${project.id}`);
                }, 0);
              }}
              onRenameProject={() => {
                setRenameProjectState({ projectId: project.id, currentName: project.name, newName: project.name });
              }}
              onDeleteProject={() => {
                setDeleteProjectConfirm({ projectId: project.id, name: project.name });
              }}
              onSelectThread={(threadId) => {
                setTimeout(() => {
                  const store = useThreadStore.getState();
                  // If already on this thread's URL but activeThread didn't load, re-select directly
                  if (store.selectedThreadId === threadId && (!store.activeThread || store.activeThread.id !== threadId)) {
                    store.selectThread(threadId);
                  }
                  navigate(`/projects/${project.id}/threads/${threadId}`);
                }, 0);
              }}
              onArchiveThread={(threadId, title) => {
                const threads = threadsByProject[project.id] ?? [];
                const th = threads.find(t => t.id === threadId);
                setArchiveConfirm({ threadId, projectId: project.id, title, isWorktree: th?.mode === 'worktree' && !!th?.branch && th?.provider !== 'external' });
              }}
              onPinThread={(threadId, pinned) => {
                pinThread(threadId, project.id, pinned);
              }}
              onDeleteThread={(threadId, title) => {
                const threads = threadsByProject[project.id] ?? [];
                const th = threads.find(t => t.id === threadId);
                setDeleteThreadConfirm({ threadId, projectId: project.id, title, isWorktree: th?.mode === 'worktree' && !!th?.branch && th?.provider !== 'external' });
              }}
              onShowAllThreads={() => {
                showGlobalSearch();
                navigate(`/search?project=${project.id}`);
              }}
            />
          ))}
        </div>
      </SidebarContent>

      {/* Footer with settings gear + user section */}
      <SidebarFooter>
        <div className="flex items-center justify-between px-1">
          {authMode === 'multi' && authUser ? (
            <span className="text-sm text-sidebar-foreground truncate">{authUser.displayName}</span>
          ) : (
            <div />
          )}
          <div className="flex items-center gap-1">
            {authMode === 'multi' && authUser && (
              <Button variant="ghost" size="sm" onClick={logout} className="text-xs text-muted-foreground">
                {t('auth.logout')}
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setGeneralSettingsOpen(true)}
                  className="text-muted-foreground h-7 w-7"
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('settings.title')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </SidebarFooter>

      <GeneralSettingsDialog open={generalSettingsOpen} onOpenChange={setGeneralSettingsOpen} />

      {/* Archive confirmation dialog */}
      <Dialog
        open={!!archiveConfirm}
        onOpenChange={(open) => { if (!open) setArchiveConfirm(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.archiveThread')}</DialogTitle>
            <DialogDescription className="break-all">
              {t('dialog.archiveThreadDesc', { title: archiveConfirm?.title && archiveConfirm.title.length > 80 ? archiveConfirm.title.slice(0, 80) + '…' : archiveConfirm?.title })}
            </DialogDescription>
          </DialogHeader>
          {archiveConfirm?.isWorktree && (
            <p className="text-xs text-status-warning/80 bg-status-warning/10 rounded-md px-3 py-2">
              {t('dialog.worktreeWarning')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setArchiveConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleArchiveConfirm} loading={actionLoading}>
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
            <DialogDescription className="break-all">
              {t('dialog.deleteThreadDesc', { title: deleteThreadConfirm?.title && deleteThreadConfirm.title.length > 80 ? deleteThreadConfirm.title.slice(0, 80) + '…' : deleteThreadConfirm?.title })}
            </DialogDescription>
          </DialogHeader>
          {deleteThreadConfirm?.isWorktree && (
            <p className="text-xs text-status-warning/80 bg-status-warning/10 rounded-md px-3 py-2">
              {t('dialog.worktreeWarning')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteThreadConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDeleteThreadConfirm} loading={actionLoading}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename project dialog */}
      <Dialog
        open={!!renameProjectState}
        onOpenChange={(open) => { if (!open) setRenameProjectState(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.renameProject')}</DialogTitle>
            <DialogDescription>
              {t('dialog.renameProjectDesc', { name: renameProjectState?.currentName })}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={renameProjectState?.newName || ''}
              onChange={(e) => {
                if (renameProjectState) {
                  setRenameProjectState({ ...renameProjectState, newName: e.target.value });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleRenameProjectConfirm();
                }
              }}
              placeholder={t('sidebar.projectName')}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenameProjectState(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleRenameProjectConfirm} loading={actionLoading}>
              {t('common.save')}
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
            <Button variant="destructive" size="sm" onClick={handleDeleteProjectConfirm} loading={actionLoading}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SidebarRail />
    </Sidebar>
  );
}
