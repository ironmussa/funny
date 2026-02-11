import { useState } from 'react';
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
import { Folder, FolderOpen, FolderOpenDot, Plus, Search, Trash2, MoreHorizontal, Terminal, Settings, Pencil } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Project, Thread } from '@a-parallel/shared';
import { useGitStatusStore } from '@/stores/git-status-store';
import { ThreadItem } from './ThreadItem';

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
  onDeleteThread,
  onShowAllThreads,
}: ProjectItemProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [openDropdown, setOpenDropdown] = useState(false);
  const gitStatusByThread = useGitStatusStore((s) => s.statusByThread);

  return (
    <Collapsible
      open={isExpanded}
      onOpenChange={onToggle}
      className="mb-1 min-w-0"
    >
      <div
        className="flex items-center rounded-md hover:bg-accent/50 transition-colors"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <CollapsibleTrigger className="flex-1 flex items-center gap-1.5 px-2 py-1.5 text-xs text-left text-muted-foreground hover:text-foreground min-w-0 transition-colors">
          {isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <Folder className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          <span className="truncate font-medium">{project.name}</span>
        </CollapsibleTrigger>
        <div className="flex items-center mr-1 gap-0.5">
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewThread();
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

      <CollapsibleContent className="data-[state=open]:animate-slide-down">
        <div className="ml-3 pl-1 mt-0.5 space-y-0.5 min-w-0">
          {threads.length === 0 && (
            <p className="text-[10px] text-muted-foreground px-2 py-2">
              {t('sidebar.noThreads')}
            </p>
          )}
          {threads.slice(0, 5).map((th) => (
            <ThreadItem
              key={th.id}
              thread={th}
              projectPath={project.path}
              isSelected={selectedThreadId === th.id}
              onSelect={() => onSelectThread(th.id)}
              onArchive={() => onArchiveThread(th.id, th.title)}
              onDelete={() => onDeleteThread(th.id, th.title)}
              gitStatus={th.mode === 'worktree' ? gitStatusByThread[th.id] : undefined}
            />
          ))}
          {threads.length > 5 && (
            <button
              onClick={onShowAllThreads}
              className="text-[11px] text-muted-foreground hover:text-foreground px-2 py-1.5 transition-colors"
            >
              {t('sidebar.viewAll')}
            </button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
