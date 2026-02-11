import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
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
} from '@/components/ui/sidebar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, Folder } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { AutomationInboxButton } from './sidebar/AutomationInboxButton';
import { ThreadList } from './sidebar/ThreadList';
import { ProjectItem } from './sidebar/ProjectItem';
import { Logo3D } from './Logo3D';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';

export function AppSidebar() {
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
  const pinThread = useAppStore(s => s.pinThread);
  const deleteThread = useAppStore(s => s.deleteThread);
  const renameProject = useAppStore(s => s.renameProject);
  const deleteProject = useAppStore(s => s.deleteProject);
  const reorderProjects = useAppStore(s => s.reorderProjects);
  const settingsOpen = useAppStore(s => s.settingsOpen);
  const showAllThreads = useAppStore(s => s.showAllThreads);
  const setAddProjectOpen = useAppStore(s => s.setAddProjectOpen);
  const authMode = useAuthStore(s => s.mode);
  const authUser = useAuthStore(s => s.user);
  const logout = useAuthStore(s => s.logout);

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

  // Drag & drop state
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
    document.body.classList.add('dragging');
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    document.body.classList.remove('dragging');

    if (!over || active.id === over.id) return;

    const oldIndex = projects.findIndex((p) => p.id === active.id);
    const newIndex = projects.findIndex((p) => p.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(projects, oldIndex, newIndex);
    reorderProjects(reordered.map((p) => p.id));
  }, [projects, reorderProjects]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    document.body.classList.remove('dragging');
  }, []);

  const activeProject = projects.find((p) => p.id === activeId);

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

  const handleRenameProjectConfirm = useCallback(async () => {
    if (!renameProjectState) return;
    const { projectId, newName } = renameProjectState;
    if (!newName.trim()) {
      toast.error('Project name cannot be empty');
      return;
    }
    try {
      await renameProject(projectId, newName.trim());
      setRenameProjectState(null);
      toast.success(t('toast.projectRenamed', { name: newName.trim() }));
    } catch (error: any) {
      toast.error(error.message || 'Failed to rename project');
    }
  }, [renameProjectState, renameProject, t]);

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
    <Sidebar collapsible="offcanvas">
      {/* Logo area */}
      <SidebarHeader className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Logo3D scale={0.75} glow={0.3} />
          <span className="text-sm font-semibold tracking-tight">a-parallel</span>
        </div>
      </SidebarHeader>

      {/* Active threads section (own scroll) */}
      <div className="flex flex-col max-h-[40%] min-h-0 shrink-0">
        <div className="px-2">
          <AutomationInboxButton />
        </div>
        <div className="flex items-center justify-between px-4 pt-2 pb-1 h-8">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('sidebar.threadsTitle')}</h2>
        </div>
        <div className="overflow-y-auto min-h-0 px-2 pb-2">
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
      <div className="flex items-center justify-between px-4 pt-2 pb-1 h-8 shrink-0">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('sidebar.projects')}</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setAddProjectOpen(true)}
              className="text-muted-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('sidebar.addProject')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Projects list (fills remaining space, own scroll) */}
      <SidebarContent className="px-2 pb-2">
        {projects.length === 0 && (
          <button
            onClick={() => setAddProjectOpen(true)}
            className="w-full text-left px-2 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            {t('sidebar.noProjects')}
          </button>
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext
            items={projects.map((p) => p.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-1.5">
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
            onRenameProject={() => {
              setRenameProjectState({ projectId: project.id, currentName: project.name, newName: project.name });
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
            onPinThread={(threadId, pinned) => {
              pinThread(threadId, project.id, pinned);
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
        </div>
          </SortableContext>
          <DragOverlay>
            {activeProject && (
              <div className="px-2 py-1 text-xs bg-sidebar rounded-md shadow-md border border-border flex items-center gap-1.5 cursor-grabbing">
                <Folder className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate font-medium">{activeProject.name}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </SidebarContent>

      {/* User section (multi mode only) */}
      {authMode === 'multi' && authUser && (
        <SidebarFooter>
          <div className="flex items-center justify-between px-1">
            <span className="text-sm text-sidebar-foreground truncate">{authUser.displayName}</span>
            <Button variant="ghost" size="sm" onClick={logout} className="text-xs text-muted-foreground">
              {t('auth.logout')}
            </Button>
          </div>
        </SidebarFooter>
      )}

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
            <Button size="sm" onClick={handleRenameProjectConfirm}>
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
            <Button variant="destructive" size="sm" onClick={handleDeleteProjectConfirm}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  );
}
