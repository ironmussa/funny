import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { Project, Thread } from '@funny/shared';
import {
  AlertTriangle,
  ChevronRight,
  Folder,
  FolderOpenDot,
  Trash2,
  MoreVertical,
  Terminal,
  Settings,
  Pencil,
  BarChart3,
  CircleDot,
  SquareTerminal,
  Sparkles,
  EyeOff,
  RotateCcw,
} from 'lucide-react';
import { useState, useRef, useEffect, memo, useCallback, useMemo, type FC } from 'react';
import { useTranslation } from 'react-i18next';

import { ProjectSetupHost } from '@/components/sidebar/ProjectSetupHost';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { api } from '@/lib/api';
import { openDirectoryInEditor, getEditorLabel } from '@/lib/editor-utils';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useGitStatusStore, branchKey as computeBranchKey } from '@/stores/git-status-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';

import { ThreadItem } from './ThreadItem';
import { ViewAllButton } from './ViewAllButton';

// ── Stable wrapper so ThreadItem callbacks don't break memo ──────────
interface ProjectThreadItemProps {
  thread: Thread;
  projectId: string;
  projectPath: string;
  projectName: string;
  projectColor?: string;
  isSelected: boolean;
  gitStatus?: import('@funny/shared').GitStatusInfo;
  onSelectThread: (projectId: string, threadId: string) => void;
  onRenameThread: (projectId: string, threadId: string, title: string) => void;
  onArchiveThread: (projectId: string, threadId: string, title: string) => void;
  onPinThread: (projectId: string, threadId: string, pinned: boolean) => void;
  onDeleteThread: (projectId: string, threadId: string, title: string) => void;
}

const ProjectThreadItem: FC<ProjectThreadItemProps> = memo(function ProjectThreadItem({
  thread,
  projectId,
  projectPath,
  projectName,
  projectColor,
  isSelected,
  gitStatus,
  onSelectThread,
  onRenameThread,
  onArchiveThread,
  onPinThread,
  onDeleteThread,
}) {
  // Drag support: allow dragging threads into grid cells
  const dragRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const el = dragRef.current;
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: () => ({
        type: 'grid-thread',
        threadId: thread.id,
        projectId,
      }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
  }, [thread.id, projectId]);

  const handleSelect = useCallback(
    () => onSelectThread(projectId, thread.id),
    [onSelectThread, projectId, thread.id],
  );
  const handleRename = useCallback(
    (newTitle: string) => onRenameThread(projectId, thread.id, newTitle),
    [onRenameThread, projectId, thread.id],
  );
  const handleArchive = useCallback(
    () => onArchiveThread(projectId, thread.id, thread.title),
    [onArchiveThread, projectId, thread.id, thread.title],
  );
  const handlePin = useCallback(
    () => onPinThread(projectId, thread.id, !thread.pinned),
    [onPinThread, projectId, thread.id, thread.pinned],
  );
  const handleDelete = useCallback(
    () => onDeleteThread(projectId, thread.id, thread.title),
    [onDeleteThread, projectId, thread.id, thread.title],
  );

  const isBusy = thread.status === 'running' || thread.status === 'setting_up';

  return (
    <div ref={dragRef} className={cn(isDragging && 'opacity-50')}>
      <ThreadItem
        thread={thread}
        projectPath={projectPath}
        projectColor={projectColor}
        isSelected={isSelected}
        onSelect={handleSelect}
        href={buildPath(`/projects/${projectId}/threads/${thread.id}`)}
        onRename={handleRename}
        onArchive={isBusy ? undefined : handleArchive}
        onPin={handlePin}
        onDelete={isBusy ? undefined : handleDelete}
        gitStatus={gitStatus}
      />
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────

interface ProjectItemProps {
  project: Project;
  threads: Thread[];
  threadsLoaded: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  onToggle: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onNewThread: (projectId: string) => void;
  onRenameProject: (projectId: string, currentName: string) => void;
  onDeleteProject: (projectId: string, name: string) => void;
  onCloseProject?: (projectId: string, name: string) => void;
  onReopenProject?: (projectId: string, name: string) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onRenameThread: (projectId: string, threadId: string, title: string) => void;
  onArchiveThread: (projectId: string, threadId: string, title: string) => void;
  onPinThread: (projectId: string, threadId: string, pinned: boolean) => void;
  onDeleteThread: (projectId: string, threadId: string, title: string) => void;
  onShowAllThreads: (projectId: string) => void;
  onShowIssues: (projectId: string) => void;
}

function projectItemAreEqual(prev: ProjectItemProps, next: ProjectItemProps): boolean {
  if (prev.threads !== next.threads) return false;
  if (prev.threadsLoaded !== next.threadsLoaded) return false;
  if (prev.isExpanded !== next.isExpanded) return false;
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.onToggle !== next.onToggle) return false;
  if (prev.onSelectProject !== next.onSelectProject) return false;
  if (prev.onNewThread !== next.onNewThread) return false;
  if (prev.onRenameProject !== next.onRenameProject) return false;
  if (prev.onDeleteProject !== next.onDeleteProject) return false;
  if (prev.onCloseProject !== next.onCloseProject) return false;
  if (prev.onReopenProject !== next.onReopenProject) return false;
  if (prev.onSelectThread !== next.onSelectThread) return false;
  if (prev.onRenameThread !== next.onRenameThread) return false;
  if (prev.onArchiveThread !== next.onArchiveThread) return false;
  if (prev.onPinThread !== next.onPinThread) return false;
  if (prev.onDeleteThread !== next.onDeleteThread) return false;
  if (prev.onShowAllThreads !== next.onShowAllThreads) return false;
  if (prev.onShowIssues !== next.onShowIssues) return false;
  // Compare project by relevant fields only (ignore sortOrder, createdAt changes)
  const pp = prev.project;
  const np = next.project;
  if (
    pp.id !== np.id ||
    pp.name !== np.name ||
    pp.path !== np.path ||
    pp.color !== np.color ||
    pp.isTeamProject !== np.isTeamProject ||
    pp.organizationName !== np.organizationName ||
    pp.needsSetup !== np.needsSetup
  )
    return false;
  return true;
}

export const ProjectItem = memo(function ProjectItem({
  project,
  threads,
  threadsLoaded,
  isExpanded,
  isSelected,
  onToggle,
  onSelectProject,
  onNewThread: _onNewThread,
  onRenameProject,
  onDeleteProject,
  onCloseProject,
  onReopenProject,
  onSelectThread,
  onRenameThread,
  onArchiveThread,
  onPinThread,
  onDeleteThread,
  onShowAllThreads,
  onShowIssues,
}: ProjectItemProps) {
  const navigate = useStableNavigate();
  const { t } = useTranslation();
  const [openDropdown, setOpenDropdown] = useState(false);
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  // Pre-compute branchKeys from thread data so we don't depend on threadToBranchKey
  // (which requires a prior fetch per thread to be populated).
  const threadBranchKeys = useMemo(
    () => new Map(threads.map((t) => [t.id, computeBranchKey(t)])),
    [threads],
  );
  // Select only the git statuses for threads visible in *this* project.
  // The selector returns a fingerprint string so Zustand's Object.is check
  // skips re-renders when unrelated threads' git statuses change.
  const gitStatusFingerprint = useGitStatusStore(
    useCallback(
      (s: { statusByBranch: Record<string, import('@funny/shared').GitStatusInfo> }) => {
        let fp = '';
        for (const [id, bk] of threadBranchKeys) {
          const st = s.statusByBranch[bk];
          if (st)
            fp += `${id}:${st.state}:${st.dirtyFileCount}:${st.unpushedCommitCount}:${st.unpulledCommitCount}:${st.linesAdded}:${st.linesDeleted},`;
        }
        return fp;
      },
      [threadBranchKeys],
    ),
  );
  // Derive the actual status objects only when the fingerprint changes
  const gitStatusForThreads = useMemo(() => {
    const { statusByBranch } = useGitStatusStore.getState();
    const result: Record<string, import('@funny/shared').GitStatusInfo> = {};
    for (const [id, bk] of threadBranchKeys) {
      if (statusByBranch[bk]) result[id] = statusByBranch[bk];
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadBranchKeys, gitStatusFingerprint]);

  // Read selectedThreadId from the store directly, scoped to this project's
  // thread IDs. This avoids passing selectedThreadId as a prop from the parent,
  // which caused *every* ProjectItem to re-render on any thread selection.
  const threadIds = useMemo(() => threads.map((t) => t.id), [threads]);
  // Derive selected thread ID scoped to this project. Also used to dim the
  // project highlight when a child thread is active.
  const selectedThreadId = useThreadStore(
    useCallback(
      (s: { selectedThreadId: string | null }) =>
        s.selectedThreadId && threadIds.includes(s.selectedThreadId) ? s.selectedThreadId : null,
      [threadIds],
    ),
  );
  // Only highlight the project row when no child thread is selected
  const isProjectHighlighted = isSelected && !selectedThreadId;
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);

  // Memoize sorted & sliced threads to avoid O(n log n) sort on every render
  const visibleThreads = useMemo(() => {
    return [...threads]
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      })
      .slice(0, 5);
  }, [threads]);

  // Eagerly fetch git status for visible threads that don't have it yet.
  // Uses ensureStatusForThreads to deduplicate by branchKey across all callers.
  useEffect(() => {
    useGitStatusStore.getState().ensureStatusForThreads(visibleThreads);
  }, [visibleThreads]);

  const dragRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);

  useEffect(() => {
    const el = dragRef.current;
    if (!el) return;

    const cleanupDrag = draggable({
      element: el,
      getInitialData: () => ({ type: 'sidebar-project', projectId: project.id }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });

    const cleanupDrop = dropTargetForElements({
      element: el,
      getData: () => ({ type: 'sidebar-project', projectId: project.id }),
      canDrop: ({ source }) =>
        source.data.type === 'sidebar-project' && source.data.projectId !== project.id,
      onDragEnter: () => setIsDropTarget(true),
      onDragLeave: () => setIsDropTarget(false),
      onDrop: () => setIsDropTarget(false),
    });

    return () => {
      cleanupDrag();
      cleanupDrop();
    };
  }, [project.id]);

  return (
    <Collapsible open={isExpanded} className="min-w-0" data-project-id={project.id}>
      <div
        ref={dragRef}
        data-testid={`project-item-${project.id}`}
        className={cn(
          'group/project flex items-center rounded-md select-none',
          isProjectHighlighted
            ? 'bg-accent text-foreground'
            : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground',
          isDragging && 'opacity-50',
          isDropTarget && 'ring-2 ring-ring',
        )}
        onClick={() => onSelectProject(project.id)}
      >
        <div
          className={cn(
            'flex-1 flex items-center gap-0 px-2 py-1 text-xs text-left min-w-0',
            isDragging ? 'cursor-grabbing' : 'cursor-pointer',
          )}
        >
          <CollapsibleTrigger
            data-testid={`project-toggle-${project.id}`}
            className="-ml-0.5 flex-shrink-0 rounded p-0.5 hover:bg-accent/80"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(project.id);
            }}
          >
            <ChevronRight
              className={cn('icon-sm transition-transform duration-200', isExpanded && 'rotate-90')}
            />
          </CollapsibleTrigger>
          <span
            data-testid={`project-name-${project.id}`}
            className="ml-1.5 flex min-w-0 flex-1 items-center gap-1.5"
          >
            <Folder className="icon-sm flex-shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{project.name}</span>
            {project.needsSetup && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    data-testid={`project-needs-setup-${project.id}`}
                    className="shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSetupDialogOpen(true);
                    }}
                  >
                    <AlertTriangle className="icon-sm text-status-warning" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Local directory not configured</TooltipContent>
              </Tooltip>
            )}
          </span>
        </div>
        <div className="mr-2 flex items-center gap-0.5">
          <div
            className={cn(
              'flex items-center gap-0.5',
              openDropdown
                ? 'opacity-100'
                : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto',
            )}
          >
            <DropdownMenu open={openDropdown} onOpenChange={setOpenDropdown}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  tabIndex={-1}
                  data-testid={`project-more-actions-${project.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <MoreVertical className="icon-sm" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="bottom">
                <DropdownMenuItem
                  data-testid="project-menu-open-directory"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const result = await api.openDirectory(project.path);
                    if (result.isErr()) {
                      console.error('Failed to open directory:', result.error);
                    }
                  }}
                >
                  <FolderOpenDot className="icon-sm" />
                  {t('sidebar.openDirectory')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="project-menu-open-terminal"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const result = await api.openTerminal(project.path);
                    if (result.isErr()) {
                      console.error('Failed to open terminal:', result.error);
                    }
                  }}
                >
                  <Terminal className="icon-sm" />
                  {t('sidebar.openTerminal')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="project-menu-open-editor"
                  onClick={(e) => {
                    e.stopPropagation();
                    openDirectoryInEditor(project.path, defaultEditor);
                  }}
                >
                  <SquareTerminal className="icon-sm" />
                  {t('sidebar.openInEditor', { editor: getEditorLabel() })}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="project-menu-settings"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenDropdown(false);
                    navigate(buildPath(`/projects/${project.id}/settings/general`));
                  }}
                >
                  <Settings className="icon-sm" />
                  {t('sidebar.settings')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="project-menu-analytics"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenDropdown(false);
                    navigate(buildPath(`/projects/${project.id}/analytics`));
                  }}
                >
                  <BarChart3 className="icon-sm" />
                  {t('sidebar.analytics')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="project-menu-github-issues"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenDropdown(false);
                    onShowIssues(project.id);
                  }}
                >
                  <CircleDot className="icon-sm" />
                  {t('sidebar.githubIssues')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="project-menu-view-designs"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenDropdown(false);
                    navigate(buildPath(`/projects/${project.id}/designs`));
                  }}
                >
                  <Sparkles className="icon-sm" />
                  {t('sidebar.viewDesigns')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-testid="project-menu-rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenDropdown(false);
                    onRenameProject(project.id, project.name);
                  }}
                >
                  <Pencil className="icon-sm" />
                  {t('sidebar.renameProject')}
                </DropdownMenuItem>
                {onReopenProject ? (
                  <DropdownMenuItem
                    data-testid="project-menu-reopen"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenDropdown(false);
                      onReopenProject(project.id, project.name);
                    }}
                  >
                    <RotateCcw className="icon-sm" />
                    {t('sidebar.reopenProject')}
                  </DropdownMenuItem>
                ) : (
                  onCloseProject && (
                    <DropdownMenuItem
                      data-testid="project-menu-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenDropdown(false);
                        onCloseProject(project.id, project.name);
                      }}
                    >
                      <EyeOff className="icon-sm" />
                      {t('sidebar.closeProject')}
                    </DropdownMenuItem>
                  )
                )}
                <DropdownMenuItem
                  data-testid="project-menu-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenDropdown(false);
                    onDeleteProject(project.id, project.name);
                  }}
                  className="text-status-error focus:text-status-error"
                >
                  <Trash2 className="icon-sm" />
                  {t('sidebar.deleteProject')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <CollapsibleContent className="data-[state=open]:animate-slide-down">
        <div className="mt-0.5 min-w-0">
          {threads.length === 0 && !threadsLoaded && (
            <div
              aria-hidden
              data-testid={`project-threads-skeleton-${project.id}`}
              className="flex flex-col gap-0.5 px-2 py-1"
            >
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-1.5 py-1">
                  <Skeleton className="h-3.5 w-3.5 rounded-full" />
                  <Skeleton className="h-3" style={{ width: `${55 + ((i * 23) % 30)}%` }} />
                </div>
              ))}
            </div>
          )}
          {threads.length === 0 && threadsLoaded && (
            <p className="px-2 py-2 text-xs text-muted-foreground">{t('sidebar.noThreads')}</p>
          )}
          {visibleThreads.map((th) => (
            <ProjectThreadItem
              key={th.id}
              thread={th}
              projectId={project.id}
              projectPath={project.path}
              projectName={project.name}
              projectColor={project.color}
              isSelected={selectedThreadId === th.id}
              gitStatus={gitStatusForThreads[th.id]}
              onSelectThread={onSelectThread}
              onRenameThread={onRenameThread}
              onArchiveThread={onArchiveThread}
              onPinThread={onPinThread}
              onDeleteThread={onDeleteThread}
            />
          ))}
          {threads.length > 5 && (
            <ViewAllButton
              data-testid={`project-view-all-${project.id}`}
              onClick={() => onShowAllThreads(project.id)}
            />
          )}
        </div>
      </CollapsibleContent>

      <ProjectSetupHost
        project={project}
        open={setupDialogOpen}
        onOpenChange={setSetupDialogOpen}
      />
    </Collapsible>
  );
}, projectItemAreEqual);
