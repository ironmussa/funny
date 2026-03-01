import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { Project, Thread } from '@funny/shared';
import {
  Folder,
  FolderOpen,
  FolderOpenDot,
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
import { useSettingsStore } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';

import { ThreadItem } from './ThreadItem';
import { ViewAllButton } from './ViewAllButton';

interface ProjectItemProps {
  project: Project;
  threads: Thread[];
  isExpanded: boolean;
  isSelected: boolean;
  onToggle: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
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
  onSelectProject,
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
  const visibleThreadIds = useMemo(() => threads.map((t) => t.id), [threads]);
  const gitStatusFingerprint = useGitStatusStore(
    useCallback(
      (s: { statusByThread: Record<string, import('@funny/shared').GitStatusInfo> }) => {
        // Build a stable fingerprint from only the relevant threads
        let fp = '';
        for (const id of visibleThreadIds) {
          const st = s.statusByThread[id];
          if (st)
            fp += `${id}:${st.state}:${st.dirtyFileCount}:${st.unpushedCommitCount}:${st.linesAdded}:${st.linesDeleted},`;
        }
        return fp;
      },
      [visibleThreadIds],
    ),
  );
  // Derive the actual status objects only when the fingerprint changes
  const statusByThread = useGitStatusStore.getState().statusByThread;
  const gitStatusForThreads = useMemo(() => {
    const result: Record<string, import('@funny/shared').GitStatusInfo> = {};
    for (const id of visibleThreadIds) {
      if (statusByThread[id]) result[id] = statusByThread[id];
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleThreadIds, gitStatusFingerprint]);
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
        <div
          data-testid={`project-item-${project.id}`}
          className={cn(
            'flex-1 flex items-center gap-0 px-2 py-1 text-xs text-left min-w-0',
            isSelected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            isDragging ? 'cursor-grabbing' : 'cursor-pointer',
          )}
        >
          <CollapsibleTrigger
            data-testid={`project-toggle-${project.id}`}
            className="-ml-0.5 flex-shrink-0 rounded p-0.5 hover:bg-accent/50"
            onClick={(e) => e.stopPropagation()}
          >
            {isExpanded ? (
              <FolderOpen className="h-3.5 w-3.5" />
            ) : (
              <Folder className="h-3.5 w-3.5" />
            )}
          </CollapsibleTrigger>
          <button
            type="button"
            data-testid={`project-name-${project.id}`}
            className="ml-1.5 flex min-w-0 items-center gap-1.5"
            onClick={(e) => {
              e.stopPropagation();
              onSelectProject(project.id);
            }}
          >
            <span className="truncate text-sm font-medium">{project.name}</span>
          </button>
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  data-testid={`project-search-threads-${project.id}`}
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
                  data-testid={`project-more-actions-${project.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
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
                  <FolderOpenDot className="h-3.5 w-3.5" />
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
                  <Terminal className="h-3.5 w-3.5" />
                  {t('sidebar.openTerminal')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="project-menu-open-editor"
                  onClick={(e) => {
                    e.stopPropagation();
                    openDirectoryInEditor(project.path, defaultEditor);
                  }}
                >
                  <SquareTerminal className="h-3.5 w-3.5" />
                  {t('sidebar.openInEditor')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="project-menu-settings"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/projects/${project.id}/settings/general`);
                  }}
                >
                  <Settings className="h-3.5 w-3.5" />
                  {t('sidebar.settings')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="project-menu-analytics"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/projects/${project.id}/analytics`);
                  }}
                >
                  <BarChart3 className="h-3.5 w-3.5" />
                  {t('sidebar.analytics')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="project-menu-github-issues"
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
                  data-testid="project-menu-rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRenameProject(project.id, project.name);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {t('sidebar.renameProject')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="project-menu-delete"
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
                  data-testid={`project-new-thread-${project.id}`}
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
        <div className="mt-0.5 min-w-0">
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
              gitStatus={gitStatusForThreads[th.id]}
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
    </Collapsible>
  );
});
