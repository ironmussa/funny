import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { Project, Thread } from '@funny/shared';
import {
  Folder,
  FolderOpen,
  FolderOpenDot,
  GitBranch,
  Search,
  Trash2,
  MoreHorizontal,
  Terminal,
  Settings,
  Pencil,
  Plus,
  BarChart3,
  CircleDot,
  SquareTerminal,
} from 'lucide-react';
import { useState, useRef, useEffect, memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { openDirectoryInEditor } from '@/lib/editor-utils';
import { cn } from '@/lib/utils';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';

import { ThreadItem } from './ThreadItem';

interface ProjectItemProps {
  project: Project;
  threads: Thread[];
  isExpanded: boolean;
  isSelected: boolean;
  onToggle: (projectId: string) => void;
  onNewThread: (projectId: string) => void;
  onRenameProject: (projectId: string, currentName: string) => void;
  onDeleteProject: (projectId: string, name: string) => void;
  onSelectThread: (projectId: string, threadId: string) => void;
  onArchiveThread: (projectId: string, threadId: string, title: string) => void;
  onPinThread: (projectId: string, threadId: string, pinned: boolean) => void;
  onDeleteThread: (projectId: string, threadId: string, title: string) => void;
  onShowAllThreads: (projectId: string) => void;
  onShowIssues: (projectId: string) => void;
}

export const ProjectItem = memo(function ProjectItem({
  project,
  threads,
  isExpanded,
  isSelected,
  onToggle,
  onNewThread,
  onRenameProject,
  onDeleteProject,
  onSelectThread,
  onArchiveThread,
  onPinThread,
  onDeleteThread,
  onShowAllThreads,
  onShowIssues,
}: ProjectItemProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [openDropdown, setOpenDropdown] = useState(false);
  // Select only the git statuses for threads visible in *this* project.
  // The selector returns a fingerprint string so Zustand's Object.is check
  // skips re-renders when unrelated threads' git statuses change.
  const visibleWorktreeIds = useMemo(
    () => threads.filter((t) => t.mode === 'worktree').map((t) => t.id),
    [threads],
  );
  const gitStatusFingerprint = useGitStatusStore(
    useCallback(
      (s: { statusByThread: Record<string, import('@funny/shared').GitStatusInfo> }) => {
        // Build a stable fingerprint from only the relevant threads
        let fp = '';
        for (const id of visibleWorktreeIds) {
          const st = s.statusByThread[id];
          if (st)
            fp += `${id}:${st.state}:${st.dirtyFileCount}:${st.unpushedCommitCount}:${st.linesAdded}:${st.linesDeleted},`;
        }
        return fp;
      },
      [visibleWorktreeIds],
    ),
  );
  // Derive the actual status objects only when the fingerprint changes
  const statusByThread = useGitStatusStore.getState().statusByThread;
  const gitStatusForThreads = useMemo(() => {
    const result: Record<string, import('@funny/shared').GitStatusInfo> = {};
    for (const id of visibleWorktreeIds) {
      if (statusByThread[id]) result[id] = statusByThread[id];
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleWorktreeIds, gitStatusFingerprint]);
  // Read selectedThreadId from the store directly, scoped to this project's
  // thread IDs. This avoids passing selectedThreadId as a prop from the parent,
  // which caused *every* ProjectItem to re-render on any thread selection.
  const threadIds = useMemo(() => threads.map((t) => t.id), [threads]);
  const selectedThreadId = useThreadStore(
    useCallback(
      (s: { selectedThreadId: string | null }) =>
        s.selectedThreadId && threadIds.includes(s.selectedThreadId) ? s.selectedThreadId : null,
      [threadIds],
    ),
  );
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const branch = useProjectStore(useCallback((s) => s.branchByProject[project.id], [project.id]));

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
    <Collapsible
      open={isExpanded}
      onOpenChange={() => onToggle(project.id)}
      className="min-w-0"
      data-project-id={project.id}
    >
      <div
        ref={dragRef}
        className={cn(
          'group/project flex items-center rounded-md select-none',
          !isSelected && 'hover:bg-accent/50',
          isDragging && 'opacity-50',
          isDropTarget && 'ring-2 ring-ring',
        )}
      >
        <CollapsibleTrigger
          className={cn(
            'flex-1 flex items-center gap-1.5 px-2 py-1 text-xs text-left min-w-0',
            isSelected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            isDragging ? 'cursor-grabbing' : 'cursor-pointer',
          )}
        >
          {isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <Folder className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          <span className="truncate text-xs font-medium">{project.name}</span>
          {branch && (
            <span className="inline-flex items-center gap-0.5 truncate text-[11px] font-normal text-muted-foreground">
              <GitBranch className="h-3 w-3 flex-shrink-0" />
              {branch}
            </span>
          )}
        </CollapsibleTrigger>
        <div className="mr-2 flex items-center gap-0.5">
          <div
            className={cn(
              'flex items-center gap-0.5',
              openDropdown
                ? 'opacity-100'
                : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto',
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowAllThreads(project.id);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Search className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('sidebar.searchThreads')}</TooltipContent>
            </Tooltip>
            <DropdownMenu onOpenChange={setOpenDropdown}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="bottom">
                <DropdownMenuItem
                  onClick={async (e) => {
                    e.stopPropagation();
                    const result = await api.openDirectory(project.path);
                    if (result.isErr()) {
                      console.error('Failed to open directory:', result.error);
                    }
                  }}
                >
                  <FolderOpenDot className="h-3.5 w-3.5" />
                  {t('sidebar.openDirectory')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={async (e) => {
                    e.stopPropagation();
                    const result = await api.openTerminal(project.path);
                    if (result.isErr()) {
                      console.error('Failed to open terminal:', result.error);
                    }
                  }}
                >
                  <Terminal className="h-3.5 w-3.5" />
                  {t('sidebar.openTerminal')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    openDirectoryInEditor(project.path, defaultEditor);
                  }}
                >
                  <SquareTerminal className="h-3.5 w-3.5" />
                  {t('sidebar.openInEditor')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/projects/${project.id}/settings/general`);
                  }}
                >
                  <Settings className="h-3.5 w-3.5" />
                  {t('sidebar.settings')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/projects/${project.id}/analytics`);
                  }}
                >
                  <BarChart3 className="h-3.5 w-3.5" />
                  {t('sidebar.analytics')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowIssues(project.id);
                  }}
                >
                  <CircleDot className="h-3.5 w-3.5" />
                  {t('sidebar.githubIssues')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onRenameProject(project.id, project.name);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {t('sidebar.renameProject')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteProject(project.id, project.name);
                  }}
                  className="text-status-error focus:text-status-error"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('sidebar.deleteProject')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewThread(project.id);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('sidebar.newThread')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      <CollapsibleContent className="data-[state=open]:animate-slide-down">
        <div className="ml-3 mt-0.5 min-w-0 pl-1">
          {threads.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">{t('sidebar.noThreads')}</p>
          )}
          {visibleThreads.map((th) => (
            <ThreadItem
              key={th.id}
              thread={th}
              projectPath={project.path}
              isSelected={selectedThreadId === th.id}
              onSelect={() => onSelectThread(project.id, th.id)}
              onArchive={
                th.status === 'running'
                  ? undefined
                  : () => onArchiveThread(project.id, th.id, th.title)
              }
              onPin={() => onPinThread(project.id, th.id, !th.pinned)}
              onDelete={
                th.status === 'running'
                  ? undefined
                  : () => onDeleteThread(project.id, th.id, th.title)
              }
              gitStatus={th.mode === 'worktree' ? gitStatusForThreads[th.id] : undefined}
            />
          ))}
          {threads.length > 5 && (
            <button
              onClick={() => onShowAllThreads(project.id)}
              className="px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('sidebar.viewAll')}
            </button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
