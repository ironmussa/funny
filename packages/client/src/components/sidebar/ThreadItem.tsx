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
import { useState, useRef, useEffect, memo, useCallback } from 'react';
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
import { threadsVisuallyEqual } from '@/lib/shallow-compare';
import { statusConfig, gitSyncStateConfig, timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

export interface ThreadItemProps {
  thread: Thread;
  projectPath: string;
  isSelected: boolean;
  onSelect: () => void;
  subtitle?: string;
  projectColor?: string;
  timeValue?: string;
  onRename?: (newTitle: string) => void;
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
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const handleDropdownChange = useCallback((open: boolean) => setOpenDropdown(open), []);

  const startRename = useCallback(() => {
    setRenameValue(thread.title);
    setIsRenaming(true);
  }, [thread.title]);

  const commitRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== thread.title && onRename) {
      onRename(trimmed);
    }
    setIsRenaming(false);
  }, [renameValue, thread.title, onRename]);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

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

  // Whether to show the second row (has project subtitle or git diff stats)
  const hasDiffStats =
    showGitIcon &&
    (gitStatus.linesAdded > 0 || gitStatus.linesDeleted > 0 || gitStatus.dirtyFileCount > 0);
  const hasGitIconOnly = showGitIcon && !hasDiffStats && GitIcon;
  const hasSnippet = !!thread.lastAssistantMessage;
  const showLaunching = isBusy && !hasSnippet;
  const hasMetadataRow = !!subtitle || hasDiffStats || hasGitIconOnly;
  const hasSnippetRow = hasSnippet || showLaunching;
  const hasSecondRow = hasMetadataRow || hasSnippetRow;

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
        className={cn(
          'flex min-w-0 flex-1 flex-col overflow-hidden text-left',
          hasSecondRow ? 'py-1.5 pl-2 gap-0.5' : 'py-1 pl-2 justify-center',
        )}
      >
        {/* Row 1: Status icon + Title */}
        <div className="flex min-w-0 items-center gap-1.5">
          {/* Thread status / pin icon */}
          <div className="relative h-3.5 w-3.5 flex-shrink-0">
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
              <span
                className={cn('absolute inset-0', onPin && !isBusy && 'group-hover/thread:hidden')}
              >
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
            {onPin && !isBusy && (
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
          {isRenaming ? (
            <input
              ref={renameInputRef}
              data-testid={`thread-rename-input-${thread.id}`}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setIsRenaming(false);
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-5 w-full min-w-0 truncate rounded border border-border bg-background px-1 text-sm leading-tight text-foreground outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <span className="truncate text-sm leading-tight">{thread.title}</span>
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
          {/* Remote runtime badge */}
          {thread.runtime === 'remote' && (
            <span className="flex-shrink-0 rounded bg-violet-500/15 px-1 py-0.5 text-[10px] font-medium leading-none text-violet-500">
              Remote
            </span>
          )}
        </div>

        {/* Row 2: Project chip + Git status */}
        {hasMetadataRow && (
          <div className="flex min-w-0 items-center gap-1.5 pl-5">
            {subtitle && (
              <ProjectChip
                name={subtitle}
                color={projectColor}
                size="sm"
                className="flex-shrink-0"
              />
            )}
            {hasDiffStats ? (
              <DiffStats
                linesAdded={gitStatus.linesAdded}
                linesDeleted={gitStatus.linesDeleted}
                dirtyFileCount={gitStatus.dirtyFileCount}
                size="xs"
              />
            ) : hasGitIconOnly ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <GitIcon className={cn('h-3 w-3 flex-shrink-0', gitCfg!.className)} />
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {gitTooltip}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        )}
        {/* Row 3: Last agent message snippet or launching indicator */}
        {hasSnippetRow && (
          <div className="flex min-w-0 items-center pl-5">
            {hasSnippet ? (
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/50">
                {thread.lastAssistantMessage}
              </span>
            ) : showLaunching ? (
              <span className="min-w-0 flex-1 truncate text-xs italic text-muted-foreground/50">
                {t('thread.launching', 'Launching...')}
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
                {onRename && (
                  <DropdownMenuItem
                    data-testid={`thread-rename-${thread.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename();
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
    </div>
  );
}, threadItemAreEqual);
