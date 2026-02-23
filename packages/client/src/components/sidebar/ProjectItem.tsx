import { useState, useRef, useEffect, memo, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Folder, FolderOpen, FolderOpenDot, Search, Trash2, MoreHorizontal, Terminal, Settings, Pencil, Plus, BarChart3, CircleDot, SquareTerminal, Zap } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Project, Thread } from '@funny/shared';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useSettingsStore } from '@/stores/settings-store';
import { openDirectoryInEditor, getEditorLabel } from '@/lib/editor-utils';
import { ThreadItem } from './ThreadItem';
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

interface ProjectItemProps {
  project: Project;
  threads: Thread[];
  isExpanded: boolean;
  isSelected: boolean;
  selectedThreadId: string | null;
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
  onTriggerWorkflow?: (projectId: string, projectPath: string) => void;
}

export const ProjectItem = memo(function ProjectItem({
  project,
  threads,
  isExpanded,
  isSelected,
  selectedThreadId,
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
  onTriggerWorkflow,
}: ProjectItemProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [openDropdown, setOpenDropdown] = useState(false);
  const gitStatusByThread = useGitStatusStore((s) => s.statusByThread);
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);

  // Memoize sorted & sliced threads to avoid O(n log n) sort on every render
  const visibleThreads = useMemo(() => {
    return [...threads]
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return 0;
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
      canDrop: ({ source }) => source.data.type === 'sidebar-project' && source.data.projectId !== project.id,
      onDragEnter: () => setIsDropTarget(true),
      onDragLeave: () => setIsDropTarget(false),
      onDrop: () => setIsDropTarget(false),
    });

    return () => { cleanupDrag(); cleanupDrop(); };
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
          "group/project flex items-center rounded-md hover:bg-accent/50 select-none",
          isDragging && "opacity-50",
          isDropTarget && "ring-2 ring-ring"
        )}
      >
        <CollapsibleTrigger className={cn(
          "flex-1 flex items-center gap-1.5 px-2 py-1 text-xs text-left text-muted-foreground hover:text-foreground min-w-0",
          isDragging ? "cursor-grabbing" : "cursor-pointer"
        )}>
          {isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <Folder className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          <span className="truncate font-medium text-xs">{project.name}</span>
        </CollapsibleTrigger>
        <div className="flex items-center mr-2 gap-0.5">
          <div className={cn(
            'flex items-center gap-0.5',
            openDropdown
              ? 'opacity-100'
              : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto'
          )}>
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
              <TooltipContent side="bottom">
                {t('sidebar.searchThreads')}
              </TooltipContent>
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
                    try {
                      await fetch('/api/browse/open-directory', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: project.path }),
                      });
                    } catch (error) {
                      console.error('Failed to open directory:', error);
                    }
                  }}
                >
                  <FolderOpenDot className="h-3.5 w-3.5" />
                  {t('sidebar.openDirectory')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await fetch('/api/browse/open-terminal', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: project.path }),
                      });
                    } catch (error) {
                      console.error('Failed to open terminal:', error);
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
                {onTriggerWorkflow && (
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onTriggerWorkflow(project.id, project.path);
                    }}
                  >
                    <Zap className="h-3.5 w-3.5" />
                    Run Pipeline
                  </DropdownMenuItem>
                )}
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
              <TooltipContent side="bottom">
                {t('sidebar.newThread')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      <CollapsibleContent className="data-[state=open]:animate-slide-down">
        <div className="ml-3 pl-1 mt-0.5 min-w-0">
          {threads.length === 0 && (
            <p className="text-xs text-muted-foreground px-2 py-2">
              {t('sidebar.noThreads')}
            </p>
          )}
          {visibleThreads.map((th) => (
            <ThreadItem
              key={th.id}
              thread={th}
              projectPath={project.path}
              isSelected={selectedThreadId === th.id}
              onSelect={() => onSelectThread(project.id, th.id)}
              onArchive={th.status === 'running' ? undefined : () => onArchiveThread(project.id, th.id, th.title)}
              onPin={() => onPinThread(project.id, th.id, !th.pinned)}
              onDelete={th.status === 'running' ? undefined : () => onDeleteThread(project.id, th.id, th.title)}
              gitStatus={th.mode === 'worktree' ? gitStatusByThread[th.id] : undefined}
            />
          ))}
          {threads.length > 5 && (
            <button
              onClick={() => onShowAllThreads(project.id)}
              className="text-sm text-muted-foreground hover:text-foreground px-2 py-1.5 transition-colors"
            >
              {t('sidebar.viewAll')}
            </button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
