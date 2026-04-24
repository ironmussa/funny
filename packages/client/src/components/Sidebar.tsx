import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { Thread } from '@funny/shared';
import {
  Columns3,
  BarChart3,
  FolderPlus,
  Settings,
  LayoutGrid,
  LogOut,
  MoreVertical,
  Search,
  PanelLeftClose,
  User,
} from 'lucide-react';
import { useState, useCallback, useEffect, useRef, useMemo, startTransition } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorktreeDeleteDialog } from '@/components/WorktreeDeleteDialog';
import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { api } from '@/lib/api';
import { threadsVisuallyEqual } from '@/lib/shallow-compare';
import { buildPath } from '@/lib/url';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { IssuesDialog } from './IssuesDialog';
import { OrgSwitcher } from './OrgSwitcher';
import { SettingsPanel } from './SettingsPanel';
import { AutomationInboxButton } from './sidebar/AutomationInboxButton';
import { ProjectItem } from './sidebar/ProjectItem';
import { ThreadList } from './sidebar/ThreadList';

const EMPTY_THREADS: Thread[] = [];

export function AppSidebar() {
  const navigate = useStableNavigate();
  const { t } = useTranslation();
  const { toggleSidebar } = useSidebar();
  // project-store
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const expandedProjects = useProjectStore((s) => s.expandedProjects);
  const toggleProject = useProjectStore((s) => s.toggleProject);
  const _loadProjects = useProjectStore((s) => s.loadProjects);
  const renameProject = useProjectStore((s) => s.renameProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  // thread-store
  const threadsByProject = useThreadStore((s) => s.threadsByProject);
  const archiveThread = useThreadStore((s) => s.archiveThread);
  const renameThread = useThreadStore((s) => s.renameThread);
  const pinThread = useThreadStore((s) => s.pinThread);
  const deleteThread = useThreadStore((s) => s.deleteThread);
  // ui-store
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const startNewThread = useUIStore((s) => s.startNewThread);
  const showGlobalSearch = useUIStore((s) => s.showGlobalSearch);
  const authUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  // branch-switch
  const { ensureBranch, branchSwitchDialog } = useBranchSwitch();

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
    worktreePath?: string | null;
    branchName?: string | null;
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
  const [issuesProjectId, setIssuesProjectId] = useState<string | null>(null);
  const projectsScrollRef = useRef<HTMLDivElement>(null);
  const threadsScrollRef = useRef<HTMLDivElement>(null);
  const [threadsScrolled, setThreadsScrolled] = useState(false);
  const [projectsScrolled, setProjectsScrolled] = useState(false);

  // Auto-scroll projects list to selected project (e.g. after Ctrl+K)
  useEffect(() => {
    if (!selectedProjectId || !projectsScrollRef.current) return;
    const el = projectsScrollRef.current.querySelector(`[data-project-id="${selectedProjectId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedProjectId]);

  // Drag & drop: auto-scroll the projects and threads lists while dragging near
  // their top/bottom edges, so the user can drop above/below the visible area.
  useEffect(() => {
    const projectsEl = projectsScrollRef.current;
    const threadsEl = threadsScrollRef.current;
    const cleanups: Array<() => void> = [];
    if (projectsEl) {
      cleanups.push(
        autoScrollForElements({
          element: projectsEl,
          canScroll: ({ source }) => source.data.type === 'sidebar-project',
        }),
      );
    }
    if (threadsEl) {
      cleanups.push(
        autoScrollForElements({
          element: threadsEl,
          canScroll: ({ source }) => source.data.type === 'grid-thread',
        }),
      );
    }
    return () => {
      for (const c of cleanups) c();
    };
  }, []);

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

  // Track scroll position for top fade gradients (throttled via rAF to avoid excessive re-renders)
  useEffect(() => {
    const threadsEl = threadsScrollRef.current;
    const projectsEl = projectsScrollRef.current;
    let threadsRaf = 0;
    let projectsRaf = 0;
    const onThreadsScroll = () => {
      if (threadsRaf) return;
      threadsRaf = requestAnimationFrame(() => {
        threadsRaf = 0;
        setThreadsScrolled((threadsEl?.scrollTop ?? 0) > 2);
      });
    };
    const onProjectsScroll = () => {
      if (projectsRaf) return;
      projectsRaf = requestAnimationFrame(() => {
        projectsRaf = 0;
        setProjectsScrolled((projectsEl?.scrollTop ?? 0) > 2);
      });
    };
    threadsEl?.addEventListener('scroll', onThreadsScroll, { passive: true });
    projectsEl?.addEventListener('scroll', onProjectsScroll, { passive: true });
    // Check initial scroll position on mount
    setThreadsScrolled((threadsEl?.scrollTop ?? 0) > 2);
    setProjectsScrolled((projectsEl?.scrollTop ?? 0) > 2);
    return () => {
      threadsEl?.removeEventListener('scroll', onThreadsScroll);
      projectsEl?.removeEventListener('scroll', onProjectsScroll);
      if (threadsRaf) cancelAnimationFrame(threadsRaf);
      if (projectsRaf) cancelAnimationFrame(projectsRaf);
    };
  }, []);

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
      setActionLoading(true);
      const { threadId, projectId, title, worktreePath, branchName } = deleteThreadConfirm;
      const wasSelected = useThreadStore.getState().selectedThreadId === threadId;

      // If branch cleanup requested, call removeWorktree explicitly before deleteThread
      if (options?.deleteBranch && worktreePath && branchName) {
        await api.removeWorktree(projectId, worktreePath, {
          branchName,
          deleteBranch: true,
        });
      }

      await deleteThread(threadId, projectId);
      setActionLoading(false);
      setDeleteThreadConfirm(null);
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

  // ── Stable callbacks for ProjectItem (avoids breaking memo) ──────────
  const handleToggleProject = useCallback(
    (projectId: string) => {
      toggleProject(projectId);
    },
    [toggleProject],
  );

  const handleSelectProject = useCallback(
    (projectId: string) => {
      startTransition(() => {
        useProjectStore.getState().selectProject(projectId);
        useUIStore.getState().setReviewPaneOpen(false);
        navigate(buildPath(`/projects/${projectId}`));
      });
      requestAnimationFrame(() => {
        const el = projectsScrollRef.current?.querySelector(`[data-project-id="${projectId}"]`);
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        const ta = document.querySelector<HTMLElement>('[data-testid="prompt-editor"]');
        ta?.focus();
      });
    },
    [navigate],
  );

  const handleNewThread = useCallback(
    (projectId: string) => {
      startTransition(() => {
        startNewThread(projectId);
        navigate(buildPath(`/projects/${projectId}`));
      });
    },
    [startNewThread, navigate],
  );

  const handleRenameProject = useCallback((projectId: string, currentName: string) => {
    setRenameProjectState({ projectId, currentName, newName: currentName });
  }, []);

  const handleDeleteProject = useCallback((projectId: string, name: string) => {
    setDeleteProjectConfirm({ projectId, name });
  }, []);

  const handleSelectThread = useCallback(
    async (projectId: string, threadId: string) => {
      // Check if the thread requires a branch switch (local mode only)
      const threads = useThreadStore.getState().threadsByProject[projectId] ?? [];
      const thread = threads.find((th) => th.id === threadId);
      if (thread?.mode === 'local') {
        const branch = resolveThreadBranch(thread);
        if (branch) {
          const canProceed = await ensureBranch(projectId, branch);
          if (!canProceed) return;
        }
      }

      startTransition(() => {
        const store = useThreadStore.getState();
        if (
          store.selectedThreadId === threadId &&
          (!store.activeThread || store.activeThread.id !== threadId)
        ) {
          store.selectThread(threadId);
        }
        navigate(buildPath(`/projects/${projectId}/threads/${threadId}`));
      });
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

  // Stable callbacks for the global ThreadList (different param order than ProjectItem handlers)
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

  const handleShowAllThreads = useCallback(
    (projectId: string) => {
      showGlobalSearch();
      navigate(buildPath(`/list?project=${projectId}`));
    },
    [showGlobalSearch, navigate],
  );

  const handleShowIssues = useCallback((projectId: string) => {
    setIssuesProjectId(projectId);
  }, []);

  // Memoize per-project thread lists, preserving referential identity for
  // projects whose threads didn't change visually. This prevents unrelated
  // ProjectItem components from re-rendering when only non-visual thread
  // fields (cost, sessionId, etc.) were updated via WebSocket.
  const prevFilteredRef = useRef<Record<string, Thread[]>>({});
  const filteredThreadsByProject = useMemo(() => {
    const prevFiltered = prevFilteredRef.current;
    const result: Record<string, Thread[]> = {};
    for (const project of projects) {
      const src = threadsByProject[project.id];
      const filtered = (Array.isArray(src) ? src : []).filter((t) => !t.archived);
      const prev = prevFiltered[project.id];
      if (
        prev &&
        prev.length === filtered.length &&
        prev.every((prevT, i) => threadsVisuallyEqual(prevT, filtered[i]))
      ) {
        result[project.id] = prev;
      } else {
        result[project.id] = filtered;
      }
    }
    prevFilteredRef.current = result;
    return result;
  }, [threadsByProject, projects]);

  if (settingsOpen) {
    return <SettingsPanel />;
  }

  return (
    <Sidebar collapsible="offcanvas" className="select-none">
      {/* Header with collapse toggle */}
      <SidebarHeader className="group/header flex-row items-center justify-between px-2 py-2">
        <div className="min-w-0 flex-1">
          <OrgSwitcher />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/header:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                tabIndex={-1}
                data-testid="sidebar-search"
                onClick={() => {
                  navigate(buildPath('/list'));
                }}
                className="text-muted-foreground"
              >
                <Search className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('sidebar.search', 'Search')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                tabIndex={-1}
                data-testid="sidebar-kanban"
                onClick={() => {
                  navigate(buildPath('/kanban'));
                }}
                className="text-muted-foreground"
              >
                <Columns3 className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Kanban</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                tabIndex={-1}
                data-testid="sidebar-grid"
                onClick={() => navigate(buildPath('/grid'))}
                className="text-muted-foreground"
              >
                <LayoutGrid className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Grid</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                tabIndex={-1}
                data-testid="sidebar-analytics"
                onClick={() => navigate(buildPath('/analytics'))}
                className="text-muted-foreground"
              >
                <BarChart3 className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('sidebar.analytics')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                tabIndex={-1}
                data-testid="sidebar-collapse"
                onClick={toggleSidebar}
                className="text-muted-foreground"
              >
                <PanelLeftClose className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('sidebar.collapse', 'Collapse sidebar')}
            </TooltipContent>
          </Tooltip>
        </div>
      </SidebarHeader>

      {/* Active threads section (own scroll) */}
      <div className="flex max-h-[40%] min-h-[5rem] shrink-0 flex-col contain-paint">
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('sidebar.threadsTitle')}
          </h2>
        </div>
        <div ref={threadsScrollRef} className="relative min-h-0 overflow-y-auto px-2 pb-2">
          <div
            className={cn(
              'sticky top-0 left-0 right-0 h-4 -mb-4 bg-gradient-to-b from-sidebar to-transparent pointer-events-none z-10',
              threadsScrolled ? 'opacity-100' : 'opacity-0',
            )}
          />
          <ThreadList
            onRenameThread={handleRenameThread}
            onArchiveThread={handleArchiveThreadFromList}
            onDeleteThread={handleDeleteThreadFromList}
          />
        </div>
      </div>

      {/* Projects header (fixed, outside scroll) */}
      <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('sidebar.projects')}
        </h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              data-testid="sidebar-add-project"
              size="icon"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              onClick={() => navigate(buildPath('/new'))}
            >
              <FolderPlus className="icon-sm" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t('sidebar.addProject')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Projects list (fills remaining space, own scroll) */}
      <SidebarContent ref={projectsScrollRef} className="relative px-2 pb-2 contain-paint">
        <div
          className={cn(
            'sticky top-0 left-0 right-0 h-4 -mb-4 bg-gradient-to-b from-sidebar to-transparent pointer-events-none z-10 shrink-0',
            projectsScrolled ? 'opacity-100' : 'opacity-0',
          )}
        />
        {projects.length === 0 && (
          <button
            data-testid="sidebar-no-projects-cta"
            onClick={() => navigate(buildPath('/new'))}
            className="w-full cursor-pointer px-2 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('sidebar.noProjects')}
          </button>
        )}
        <div className="flex flex-col gap-1.5">
          {projects.map((project) => (
            <ProjectItem
              key={project.id}
              project={project}
              threads={filteredThreadsByProject[project.id] ?? EMPTY_THREADS}
              isExpanded={expandedProjects.has(project.id)}
              isSelected={selectedProjectId === project.id}
              onToggle={handleToggleProject}
              onSelectProject={handleSelectProject}
              onNewThread={handleNewThread}
              onRenameProject={handleRenameProject}
              onDeleteProject={handleDeleteProject}
              onSelectThread={handleSelectThread}
              onRenameThread={handleRenameThread}
              onArchiveThread={handleArchiveThread}
              onPinThread={handlePinThread}
              onDeleteThread={handleDeleteThread}
              onShowAllThreads={handleShowAllThreads}
              onShowIssues={handleShowIssues}
            />
          ))}
        </div>
      </SidebarContent>

      {/* Footer with automation inbox + settings */}
      <SidebarFooter className="pb-4">
        <div className="px-1">
          <AutomationInboxButton />
        </div>
        <div className="flex items-center gap-2 px-1">
          {authUser ? (
            <>
              <Avatar size="sm">
                <AvatarFallback className="text-xs" name={authUser.displayName || undefined}>
                  {authUser.displayName
                    ?.split(' ')
                    .map((n) => n[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase() || <User className="icon-sm" />}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-sidebar-foreground">
                  {authUser.displayName}
                </p>
                <p className="truncate text-xs text-muted-foreground">@{authUser.username}</p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    data-testid="sidebar-user-menu"
                    className="h-7 w-7 shrink-0 text-muted-foreground"
                  >
                    <MoreVertical className="icon-base" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" className="w-48">
                  <DropdownMenuItem
                    data-testid="sidebar-user-settings"
                    onClick={() => navigate(buildPath('/preferences/general'))}
                  >
                    <Settings className="icon-sm" />
                    {t('settings.title')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem data-testid="sidebar-logout" onClick={logout}>
                    <LogOut className="icon-sm" />
                    {t('auth.logout')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  data-testid="sidebar-settings"
                  onClick={() => navigate(buildPath('/preferences/general'))}
                  className="ml-auto h-7 w-7 text-muted-foreground"
                >
                  <Settings className="icon-base" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('settings.title')}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </SidebarFooter>

      {issuesProjectId && (
        <IssuesDialog
          projectId={issuesProjectId}
          open={!!issuesProjectId}
          onOpenChange={(open) => {
            if (!open) setIssuesProjectId(null);
          }}
          onCreateThread={(params) => {
            setIssuesProjectId(null);
            useUIStore.getState().startNewThreadFromIssue(issuesProjectId, params);
          }}
        />
      )}

      {/* Archive confirmation dialog */}
      <ConfirmDialog
        open={!!archiveConfirm}
        onOpenChange={(open) => {
          if (!open) setArchiveConfirm(null);
        }}
        title={t('dialog.archiveThread')}
        description={t('dialog.archiveThreadDesc', {
          title:
            archiveConfirm?.title && archiveConfirm.title.length > 80
              ? archiveConfirm.title.slice(0, 80) + '…'
              : archiveConfirm?.title,
        })}
        warning={archiveConfirm?.isWorktree ? t('dialog.worktreeWarning') : undefined}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('sidebar.archive')}
        variant="default"
        loading={actionLoading}
        onCancel={() => setArchiveConfirm(null)}
        onConfirm={handleArchiveConfirm}
      />

      {/* Delete thread confirmation dialog — enhanced for worktree threads */}
      {deleteThreadConfirm?.isWorktree ? (
        <WorktreeDeleteDialog
          open={!!deleteThreadConfirm}
          target={deleteThreadConfirm}
          loading={actionLoading}
          onCancel={() => setDeleteThreadConfirm(null)}
          onConfirm={({ deleteBranch }) => handleDeleteThreadConfirm({ deleteBranch })}
        />
      ) : (
        <ConfirmDialog
          open={!!deleteThreadConfirm}
          onOpenChange={(open) => {
            if (!open) setDeleteThreadConfirm(null);
          }}
          title={t('dialog.deleteThread')}
          description={t('dialog.deleteThreadDesc', {
            title:
              deleteThreadConfirm?.title && deleteThreadConfirm.title.length > 80
                ? deleteThreadConfirm.title.slice(0, 80) + '…'
                : deleteThreadConfirm?.title,
          })}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('common.delete')}
          loading={actionLoading}
          onCancel={() => setDeleteThreadConfirm(null)}
          onConfirm={() => handleDeleteThreadConfirm()}
        />
      )}

      {/* Rename project dialog */}
      <Dialog
        open={!!renameProjectState}
        onOpenChange={(open) => {
          if (!open) setRenameProjectState(null);
        }}
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
              data-testid="rename-project-input"
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
            <Button
              data-testid="rename-project-cancel"
              variant="outline"
              size="sm"
              onClick={() => setRenameProjectState(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="rename-project-confirm"
              size="sm"
              onClick={handleRenameProjectConfirm}
              loading={actionLoading}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete project confirmation dialog */}
      <ConfirmDialog
        open={!!deleteProjectConfirm}
        onOpenChange={(open) => {
          if (!open) setDeleteProjectConfirm(null);
        }}
        title={t('dialog.deleteProject')}
        description={t('dialog.deleteProjectDesc', { name: deleteProjectConfirm?.name })}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.delete')}
        loading={actionLoading}
        onCancel={() => setDeleteProjectConfirm(null)}
        onConfirm={handleDeleteProjectConfirm}
      />

      <SidebarRail />

      {branchSwitchDialog}
    </Sidebar>
  );
}
