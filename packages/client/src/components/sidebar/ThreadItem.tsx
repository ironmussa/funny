import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Archive,
  Trash2,
  MoreHorizontal,
  FolderOpenDot,
  Terminal,
  Square,
  Pin,
  PinOff,
} from 'lucide-react';
import { statusConfig, gitSyncStateConfig, timeAgo } from '@/lib/thread-utils';
import type { Thread, ThreadStatus, GitStatusInfo } from '@a-parallel/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const TERMINAL_STATUSES: ThreadStatus[] = ['completed', 'failed', 'stopped', 'interrupted'];

interface ThreadItemProps {
  thread: Thread;
  projectPath: string;
  isSelected: boolean;
  onSelect: () => void;
  subtitle?: string;
  timeValue?: string;
  onArchive?: () => void;
  onPin?: () => void;
  onDelete?: () => void;
  gitStatus?: GitStatusInfo;
}

export function ThreadItem({ thread, projectPath, isSelected, onSelect, subtitle, timeValue, onArchive, onPin, onDelete, gitStatus }: ThreadItemProps) {
  const { t } = useTranslation();
  const [openDropdown, setOpenDropdown] = useState(false);

  // Use git status icon for worktree threads in terminal states
  const useGitIcon = thread.mode === 'worktree' && TERMINAL_STATUSES.includes(thread.status) && gitStatus;
  const s = useGitIcon
    ? gitSyncStateConfig[gitStatus.state]
    : (statusConfig[thread.status as ThreadStatus] ?? statusConfig.pending);
  const Icon = s.icon;
  const isRunning = thread.status === 'running';
  const displayTime = timeValue ?? timeAgo(thread.createdAt, t);

  // Build tooltip text for git status
  let gitTooltip: string | null = null;
  if (useGitIcon) {
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
        'group/thread w-full flex items-stretch rounded-md transition-colors min-w-0',
        isSelected
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      )}
    >
      <button
        onClick={onSelect}
        className="flex-1 flex items-center gap-1.5 pl-2 py-1 text-left min-w-0 overflow-hidden"
      >
        <div className="relative h-3 w-3 flex-shrink-0">
          {/* Status icon – hidden on hover when pin is available */}
          <span className={cn(
            'absolute inset-0',
            onPin && !isRunning && 'group-hover/thread:hidden'
          )}>
            {gitTooltip ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Icon className={cn('h-3 w-3', s.className)} />
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {gitTooltip}
                </TooltipContent>
              </Tooltip>
            ) : (
              <Icon className={cn('h-3 w-3', s.className)} />
            )}
          </span>
          {/* Pin toggle – shown on hover */}
          {onPin && !isRunning && (
            <span
              className="absolute inset-0 hidden group-hover/thread:flex items-center justify-center cursor-pointer text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onPin();
              }}
            >
              {thread.pinned ? (
                <PinOff className="h-3 w-3" />
              ) : (
                <Pin className="h-3 w-3" />
              )}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-0 min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="text-sm leading-tight truncate">{thread.title}</span>
          </div>
          {subtitle && (
            <span className="text-xs text-muted-foreground font-mono truncate">{subtitle}</span>
          )}
        </div>
      </button>
      <div className="flex-shrink-0 pr-1.5 pl-2 py-1.5 grid place-items-center min-w-[2.5rem]">
        <span className={cn(
          'col-start-1 row-start-1 text-xs text-muted-foreground leading-4 h-4 group-hover/thread:hidden',
          openDropdown && 'hidden'
        )}>
          {displayTime}
        </span>
        <div className={cn(
          'col-start-1 row-start-1 hidden group-hover/thread:flex items-center h-4',
          openDropdown && '!flex'
        )}>
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
                  const folderPath = thread.worktreePath || projectPath;
                  try {
                    await fetch('/api/browse/open-directory', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ path: folderPath }),
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
                  const folderPath = thread.worktreePath || projectPath;
                  try {
                    await fetch('/api/browse/open-terminal', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ path: folderPath }),
                    });
                  } catch (error) {
                    console.error('Failed to open terminal:', error);
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
              {onArchive && (
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
              {onDelete && (
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
}
