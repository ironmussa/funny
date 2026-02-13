import { useState, useRef, useEffect } from 'react';
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
import { Folder, FolderOpen, FolderOpenDot, Search, Trash2, MoreHorizontal, Terminal, Settings, Pencil } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Project, Thread } from '@a-parallel/shared';
import { useGitStatusStore } from '@/stores/git-status-store';
import { ThreadItem } from './ThreadItem';
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';

interface ProjectItemProps {
  project: Project;
  threads: Thread[];
  isExpanded: boolean;
  selectedThreadId: string | null;
  onToggle: () => void;
  onNewThread: () => void;
  onRenameProject: () => void;
  onDeleteProject: () => void;
  onSelectThread: (threadId: string) => void;
  onArchiveThread: (threadId: string, title: string) => void;
  onPinThread: (threadId: string, pinned: boolean) => void;
  onDeleteThread: (threadId: string, title: string) => void;
  onShowAllThreads: () => void;
}

export function ProjectItem({
  project,
  threads,
  isExpanded,
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
}: ProjectItemProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [openDropdown, setOpenDropdown] = useState(false);
  const gitStatusByThread = useGitStatusStore((s) => s.statusByThread);

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
      onOpenChange={onToggle}
      className="min-w-0"
    >
      <div
        ref={dragRef}
        className={cn(
          "flex items-center rounded-md hover:bg-accent/50 transition-colors select-none",
          isDragging && "opacity-50",
          isDropTarget && "ring-2 ring-ring"
        )}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <CollapsibleTrigger className={cn(
          "flex-1 flex items-center gap-1.5 px-2 py-1 text-xs text-left text-muted-foreground hover:text-foreground min-w-0 transition-colors",
          isDragging ? "cursor-grabbing" : "cursor-pointer"
        )}>
          {project.color ? (
            <div
              className="h-3.5 w-3.5 rounded-sm flex-shrink-0"
              style={{ backgroundColor: project.color }}
            />
          ) : isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <Folder className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          <span className="truncate font-medium text-xs">{project.name}</span>
        </CollapsibleTrigger>
        <div className="flex items-center mr-2 gap-0.5">
          <div className={cn(
            'flex items-center gap-0.5 transition-opacity',
            hovered || openDropdown
              ? 'opacity-100'
              : 'opacity-0 pointer-events-none'
          )}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onShowAllThreads();
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
                    navigate(`/projects/${project.id}/settings/general`);
                  }}
                >
                  <Settings className="h-3.5 w-3.5" />
                  {t('sidebar.settings')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onRenameProject();
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {t('sidebar.renameProject')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteProject();
                  }}
                  className="text-red-400 focus:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('sidebar.deleteProject')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <CollapsibleContent className="data-[state=open]:animate-slide-down">
        <div className="ml-3 pl-1 mt-0.5 space-y-0.5 min-w-0">
          {threads.length === 0 && (
            <p className="text-xs text-muted-foreground px-2 py-2">
              {t('sidebar.noThreads')}
            </p>
          )}
          {[...threads]
            .sort((a, b) => {
              if (a.pinned && !b.pinned) return -1;
              if (!a.pinned && b.pinned) return 1;
              return 0;
            })
            .slice(0, 5)
            .map((th) => (
            <ThreadItem
              key={th.id}
              thread={th}
              projectPath={project.path}
              isSelected={selectedThreadId === th.id}
              onSelect={() => onSelectThread(th.id)}
              onArchive={() => onArchiveThread(th.id, th.title)}
              onPin={() => onPinThread(th.id, !th.pinned)}
              onDelete={() => onDeleteThread(th.id, th.title)}
              gitStatus={th.mode === 'worktree' ? gitStatusByThread[th.id] : undefined}
            />
          ))}
          {threads.length > 5 && (
            <button
              onClick={onShowAllThreads}
              className="text-sm text-muted-foreground hover:text-foreground px-2 py-1.5 transition-colors"
            >
              {t('sidebar.viewAll')}
            </button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
