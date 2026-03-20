import type { Thread, ThreadStatus, GitStatusInfo } from '@funny/shared';
import {
  Archive,
  Trash2,
  MoreVertical,
  FolderOpenDot,
  Terminal,
  Square,
  Pin,
  PinOff,
  Bot,
  Pencil,
} from 'lucide-react';
import { useState, memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

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
import { threadsVisuallyEqual } from '@/lib/shallow-compare';
import { statusConfig, timeAgo } from '@/lib/thread-utils';
import { toastError } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

export interface ThreadItemProps {
  thread: Thread;
  projectPath: string;
  isSelected: boolean;
  onSelect: () => void;
  subtitle?: string;
  projectColor?: string;
  timeValue?: string;
  onRename?: () => void;
  onArchive?: () => void;
  onPin?: () => void;
  onDelete?: () => void;
  gitStatus?: GitStatusInfo;
}

// Custom comparator: only re-render when visually-relevant props change.
// Uses shared `threadsVisuallyEqual` for the thread object comparison,
// preventing re-renders from high-churn fields (cost, sessionId, etc.).
function threadItemAreEqual(prev: ThreadItemProps, next: ThreadItemProps): boolean {
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.onSelect !== next.onSelect) return false;
  if (prev.onRename !== next.onRename) return false;
  if (prev.onArchive !== next.onArchive) return false;
  if (prev.onPin !== next.onPin) return false;
  if (prev.onDelete !== next.onDelete) return false;
  if (prev.subtitle !== next.subtitle) return false;
  if (prev.projectColor !== next.projectColor) return false;
  if (prev.timeValue !== next.timeValue) return false;
  if (prev.projectPath !== next.projectPath) return false;
  if (prev.gitStatus !== next.gitStatus) return false;
  return threadsVisuallyEqual(prev.thread, next.thread);
}

export const ThreadItem = memo(function ThreadItem({
  thread,
  projectPath,
  isSelected,
  onSelect,
  subtitle,
  projectColor,
  timeValue,
  onRename,
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
  // Sidebar icons: no color, only keep animate-spin for busy states
  const statusIconClassName = isBusy
    ? 'text-muted-foreground animate-spin'
    : 'text-muted-foreground';
  const displayTime = timeValue ?? timeAgo(thread.createdAt, t);

  // Git status — only used for diff stats
  const showGitIcon = !!gitStatus && gitStatus.state !== 'clean';

  // Whether to show the second row (has project subtitle or git diff stats)
  const hasDiffStats =
    showGitIcon &&
    (gitStatus.linesAdded > 0 || gitStatus.linesDeleted > 0 || gitStatus.dirtyFileCount > 0);
  const hasSnippet = !!thread.lastAssistantMessage;
  const showLaunching = isBusy && !hasSnippet;
  const isBacklog = !hasSnippet && !isBusy && (!thread.stage || thread.stage === 'backlog');
  const hasMetadataRow = !!subtitle || hasDiffStats;
  const hasSnippetRow = hasSnippet || showLaunching || isBacklog;

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
        className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden py-1.5 pl-2 text-left"
      >
        {/* Row 1: Status icon + Title */}
        <div className="flex min-w-0 items-center gap-1.5">
          {/* Thread status / pin icon — active statuses always show status, pin only when idle */}
          <div className="relative h-3.5 w-3.5 flex-shrink-0">
            {thread.pinned && thread.status !== 'running' && thread.status !== 'setting_up' ? (
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center text-muted-foreground',
                  onPin && 'group-hover/thread:hidden',
                )}
              >
                <Pin className="h-3.5 w-3.5" />
              </span>
            ) : (
              <span className={cn('absolute inset-0', onPin && 'group-hover/thread:hidden')}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <StatusIcon className={cn('h-3.5 w-3.5', statusIconClassName)} />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {t(`thread.status.${thread.status}`)}
                  </TooltipContent>
                </Tooltip>
              </span>
            )}
            {onPin && (
              <span
                className="absolute inset-0 hidden cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground group-hover/thread:flex"
                onClick={(e) => {
                  e.stopPropagation();
                  onPin();
                }}
              >
                {thread.pinned ? (
                  <PinOff className="h-3.5 w-3.5" />
                ) : (
                  <Pin className="h-3.5 w-3.5" />
                )}
              </span>
            )}
          </div>
          <span className="truncate text-sm leading-tight">{thread.title}</span>
          {/* External creator icon */}
          {thread.createdBy && thread.createdBy !== 'user' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Bot className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {t('thread.createdBy', { creator: thread.createdBy })}
              </TooltipContent>
            </Tooltip>
          )}
          {/* Arc purpose badge */}
          {thread.arcId && thread.purpose === 'explore' && (
            <span className="flex-shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-medium leading-none text-amber-500">
              {t('thread.purposeExplore', 'Explore')}
            </span>
          )}
          {thread.arcId && thread.purpose === 'plan' && (
            <span className="flex-shrink-0 rounded bg-blue-500/15 px-1 py-0.5 text-[10px] font-medium leading-none text-blue-500">
              {t('thread.purposePlan', 'Plan')}
            </span>
          )}
          {/* Remote runtime badge */}
          {thread.runtime === 'remote' && (
            <span className="flex-shrink-0 rounded bg-violet-500/15 px-1 py-0.5 text-[10px] font-medium leading-none text-violet-500">
              Remote
            </span>
          )}
        </div>

        {/* Row 2: Project chip + Git status + Snippet + Time */}
        {(hasMetadataRow || hasSnippetRow) && (
          <div className="flex min-w-0 items-center gap-1.5 pl-5">
            {subtitle && (
              <ProjectChip
                name={subtitle}
                color={projectColor}
                size="sm"
                className="flex-shrink-0"
              />
            )}
            {hasDiffStats && (
              <DiffStats
                linesAdded={gitStatus.linesAdded}
                linesDeleted={gitStatus.linesDeleted}
                dirtyFileCount={gitStatus.dirtyFileCount}
                size="xs"
              />
            )}
            {hasSnippet ? (
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/50">
                {thread.lastAssistantMessage}
              </span>
            ) : showLaunching ? (
              <span className="min-w-0 flex-1 truncate text-xs italic text-muted-foreground/50">
                {t('thread.launching', 'Launching...')}
              </span>
            ) : isBacklog ? (
              <span className="min-w-0 flex-1 truncate text-xs italic text-muted-foreground/50">
                {t('thread.readyToLaunch', 'Ready to Launch')}
              </span>
            ) : null}
          </div>
        )}
      </button>
      <div className="flex flex-shrink-0 items-center gap-1.5 py-1 pl-2 pr-1.5">
        <div className="grid min-w-[2.5rem] place-items-center justify-items-center">
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
                  tabIndex={-1}
                  data-testid={`thread-item-more-${thread.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="bottom">
                <DropdownMenuItem
                  onClick={async (e) => {
                    e.stopPropagation();
                    const folderPath = thread.worktreePath || projectPath;
                    const result = await api.openDirectory(folderPath);
                    if (result.isErr()) {
                      toastError(result.error);
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
                      toastError(result.error);
                    }
                  }}
                >
                  <Terminal className="h-3.5 w-3.5" />
                  {t('sidebar.openTerminal')}
                </DropdownMenuItem>
                {onRename && (
                  <DropdownMenuItem
                    data-testid={`thread-rename-${thread.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename();
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    {t('sidebar.rename')}
                  </DropdownMenuItem>
                )}
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
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      data-testid={`thread-delete-${thread.id}`}
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
    </div>
  );
}, threadItemAreEqual);
