import type { Thread, ThreadStatus, GitStatusInfo } from '@funny/shared';
import {
  Archive,
  Trash2,
  MoreHorizontal,
  FolderOpenDot,
  Terminal,
  Square,
  Pin,
  PinOff,
  Bot,
} from 'lucide-react';
import { useState, memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { DiffStats } from '@/components/DiffStats';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { ProjectChip } from '@/components/ui/project-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { statusConfig, gitSyncStateConfig, timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

interface ThreadItemProps {
  thread: Thread;
  projectPath: string;
  isSelected: boolean;
  onSelect: () => void;
  subtitle?: string;
  projectColor?: string;
  timeValue?: string;
  onArchive?: () => void;
  onPin?: () => void;
  onDelete?: () => void;
  gitStatus?: GitStatusInfo;
}

export const ThreadItem = memo(function ThreadItem({
  thread,
  projectPath,
  isSelected,
  onSelect,
  subtitle,
  projectColor,
  timeValue,
  onArchive,
  onPin,
  onDelete,
  gitStatus,
}: ThreadItemProps) {
  const { t } = useTranslation();
  const [openDropdown, setOpenDropdown] = useState(false);
  const handleDropdownChange = useCallback((open: boolean) => setOpenDropdown(open), []);

  // Thread status config
  const threadStatusCfg = statusConfig[thread.status as ThreadStatus] ?? statusConfig.pending;
  const StatusIcon = threadStatusCfg.icon;
  const isRunning = thread.status === 'running';
  const isSettingUp = thread.status === 'setting_up';
  const isBusy = isRunning || isSettingUp;
  const displayTime = timeValue ?? timeAgo(thread.createdAt, t);

  // Git status config
  const showGitIcon = !!gitStatus && gitStatus.state !== 'clean';
  const gitCfg = showGitIcon ? gitSyncStateConfig[gitStatus.state] : null;
  const GitIcon = gitCfg?.icon ?? null;

  // Build tooltip text for git status
  let gitTooltip: string | null = null;
  if (showGitIcon) {
    const label = t(gitSyncStateConfig[gitStatus.state].labelKey);
    if (gitStatus.state === 'dirty' && gitStatus.dirtyFileCount > 0) {
      gitTooltip = `${label} (${gitStatus.dirtyFileCount})`;
    } else if (gitStatus.state === 'unpushed' && gitStatus.unpushedCommitCount > 0) {
      gitTooltip = `${label} (${gitStatus.unpushedCommitCount})`;
    } else {
      gitTooltip = label;
    }
  }

  return (
    <div
      className={cn(
        'group/thread w-full flex items-stretch rounded-md min-w-0',
        isSelected
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <button
        data-testid={`thread-item-${thread.id}`}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden py-1 pl-2 text-left"
      >
        {/* Thread status / pin icon */}
        <div className="relative h-3.5 w-3.5 flex-shrink-0">
          {/* Default state: show pin icon if pinned, otherwise status icon */}
          {thread.pinned ? (
            <span
              className={cn(
                'absolute inset-0 flex items-center justify-center text-muted-foreground',
                onPin && !isBusy && 'group-hover/thread:hidden',
              )}
            >
              <Pin className="h-3.5 w-3.5" />
            </span>
          ) : (
            thread.status !== 'completed' && (
              <span
                className={cn('absolute inset-0', onPin && !isBusy && 'group-hover/thread:hidden')}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <StatusIcon className={cn('h-3.5 w-3.5', threadStatusCfg.className)} />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {t(`thread.status.${thread.status}`)}
                  </TooltipContent>
                </Tooltip>
              </span>
            )
          )}
          {/* Hover: pin/unpin toggle */}
          {onPin && !isBusy && (
            <span
              className="absolute inset-0 hidden cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground group-hover/thread:flex"
              onClick={(e) => {
                e.stopPropagation();
                onPin();
              }}
            >
              {thread.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <span className="truncate text-sm leading-tight">{thread.title}</span>
          {/* Git status (worktree threads only) */}
          {showGitIcon &&
          (gitStatus.linesAdded > 0 ||
            gitStatus.linesDeleted > 0 ||
            gitStatus.dirtyFileCount > 0) ? (
            <DiffStats
              linesAdded={gitStatus.linesAdded}
              linesDeleted={gitStatus.linesDeleted}
              dirtyFileCount={gitStatus.dirtyFileCount}
            />
          ) : showGitIcon && GitIcon ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <GitIcon className={cn('h-3 w-3 flex-shrink-0', gitCfg!.className)} />
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {gitTooltip}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {subtitle && (
            <ProjectChip name={subtitle} color={projectColor} className="flex-shrink-0" />
          )}
          {/* External creator icon */}
          {thread.createdBy && thread.createdBy !== 'user' && thread.createdBy !== '__local__' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Bot className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {t('thread.createdBy', { creator: thread.createdBy })}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </button>
      <div className="grid min-w-[2.5rem] flex-shrink-0 place-items-center justify-items-center py-1 pl-2 pr-1.5">
        <span
          className={cn(
            'col-start-1 row-start-1 text-xs text-muted-foreground leading-4 h-4 group-hover/thread:opacity-0 group-hover/thread:pointer-events-none',
            openDropdown && 'opacity-0 pointer-events-none',
          )}
        >
          {displayTime}
        </span>
        <div
          className={cn(
            'col-start-1 row-start-1 flex items-center opacity-0 group-hover/thread:opacity-100',
            openDropdown && '!opacity-100',
          )}
        >
          <DropdownMenu onOpenChange={handleDropdownChange}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                data-testid={`thread-item-more-${thread.id}`}
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
                  const folderPath = thread.worktreePath || projectPath;
                  const result = await api.openDirectory(folderPath);
                  if (result.isErr()) {
                    toast.error(result.error.message || 'Failed to open directory');
                  }
                }}
              >
                <FolderOpenDot className="h-3.5 w-3.5" />
                {t('sidebar.openDirectory')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async (e) => {
                  e.stopPropagation();
                  const folderPath = thread.worktreePath || projectPath;
                  const result = await api.openTerminal(folderPath);
                  if (result.isErr()) {
                    toast.error(result.error.message || 'Failed to open terminal');
                  }
                }}
              >
                <Terminal className="h-3.5 w-3.5" />
                {t('sidebar.openTerminal')}
              </DropdownMenuItem>
              {isRunning && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={async (e) => {
                      e.stopPropagation();
                      const result = await api.stopThread(thread.id);
                      if (result.isErr()) {
                        console.error('Failed to stop thread:', result.error);
                      }
                    }}
                    className="text-status-error focus:text-status-error"
                  >
                    <Square className="h-3.5 w-3.5" />
                    {t('common.stop')}
                  </DropdownMenuItem>
                </>
              )}
              {onArchive && !isBusy && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onArchive();
                  }}
                >
                  <Archive className="h-3.5 w-3.5" />
                  {t('sidebar.archive')}
                </DropdownMenuItem>
              )}
              {onDelete && !isBusy && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete();
                    }}
                    className="text-status-error focus:text-status-error"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('common.delete')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
});
