import type { Thread, ThreadStatus, GitStatusInfo } from '@funny/shared';
import {
  Archive,
  Trash2,
  MoreVertical,
  FolderOpenDot,
  Folder,
  Terminal,
  Square,
  Pin,
  PinOff,
  Bot,
  Pencil,
  GitBranch,
  GitPullRequest,
  GitPullRequestClosed,
  GitMerge,
} from 'lucide-react';
import { useState, memo, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { DiffStats } from '@/components/DiffStats';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import type { PowerlineSegmentData } from '@/components/ui/powerline-bar';
import { PowerlineBar } from '@/components/ui/powerline-bar';
import { colorFromName, darkenHex } from '@/components/ui/project-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { threadsVisuallyEqual } from '@/lib/shallow-compare';
import { statusConfig, timeAgo } from '@/lib/thread-utils';
import { toastError } from '@/lib/toast-error';
import { cn, resolveThreadBranch } from '@/lib/utils';

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
  const handleDropdownChange = useCallback((open: boolean) => setOpenDropdown(open), []);

  // Rename dialog state
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const openRenameDialog = useCallback(() => {
    setRenameValue(thread.title);
    setIsRenameOpen(true);
  }, [thread.title]);

  const commitRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== thread.title && onRename) {
      onRename(trimmed);
    }
    setIsRenameOpen(false);
  }, [renameValue, thread.title, onRename]);

  // Thread status config
  const threadStatusCfg = statusConfig[thread.status as ThreadStatus] ?? statusConfig.pending;
  const StatusIcon = threadStatusCfg.icon;
  const isRunning = thread.status === 'running';
  const isSettingUp = thread.status === 'setting_up';
  const isBusy = isRunning || isSettingUp;
  const displayTime = timeValue ?? timeAgo(thread.createdAt, t);

  // Keep the last known git status so the widget doesn't flicker away
  // during transient undefined gaps (e.g. thread selection race conditions).
  const lastGitStatusRef = useRef(gitStatus);
  if (gitStatus) lastGitStatusRef.current = gitStatus;
  const effectiveGitStatus = gitStatus ?? lastGitStatusRef.current;

  // Git status — only used for diff stats
  const showGitIcon = !!effectiveGitStatus && effectiveGitStatus.state !== 'clean';

  // Whether to show the second row (has project subtitle or git diff stats)
  const hasDiffStats =
    showGitIcon &&
    (effectiveGitStatus.linesAdded > 0 ||
      effectiveGitStatus.linesDeleted > 0 ||
      effectiveGitStatus.dirtyFileCount > 0);
  const hasPR = !!effectiveGitStatus?.prNumber;
  const hasSnippet = !!thread.lastAssistantMessage;
  const showLaunching = isBusy && !hasSnippet;
  const isBacklog = !hasSnippet && !isBusy && (!thread.stage || thread.stage === 'backlog');
  const hasMetadataRow = hasDiffStats || hasPR;
  const hasSnippetRow = hasSnippet || showLaunching || isBacklog;

  // Powerline segments: project → baseBranch → worktree branch (for worktrees)
  //                      project → branch (for local threads)
  const isWorktree = thread.mode === 'worktree';
  const effectiveBranch = resolveThreadBranch(thread);
  const branchName =
    isWorktree && thread.baseBranch ? thread.baseBranch : effectiveBranch || thread.baseBranch;
  const resolvedProjectColor = projectColor || (subtitle ? colorFromName(subtitle) : '#52525b');
  const worktreeBranchLabel = isWorktree ? (effectiveBranch ?? '') : '';
  const branchColor = darkenHex(resolvedProjectColor, 0.12);
  const dirColor = darkenHex(resolvedProjectColor, 0.22);
  const powerlineSegments = useMemo<PowerlineSegmentData[]>(() => {
    const segments: PowerlineSegmentData[] = [];
    if (subtitle) {
      segments.push({
        key: 'project',
        icon: Folder,
        label: subtitle,
        color: resolvedProjectColor,
        textColor: '#000000',
        tooltip: projectPath,
      });
    }
    if (branchName) {
      segments.push({
        key: 'branch',
        icon: GitBranch,
        label: branchName,
        color: subtitle ? branchColor : resolvedProjectColor,
        textColor: '#000000',
        tooltip: branchName,
      });
    }
    if (isWorktree && worktreeBranchLabel) {
      segments.push({
        key: 'worktree-branch',
        icon: GitBranch,
        label: worktreeBranchLabel,
        color: subtitle ? dirColor : branchColor,
        textColor: '#000000',
        tooltip: worktreeBranchLabel,
      });
    }
    return segments;
  }, [
    subtitle,
    resolvedProjectColor,
    projectPath,
    branchName,
    branchColor,
    isWorktree,
    worktreeBranchLabel,
    dirColor,
  ]);

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
          {/* Thread status / pin icon — pin only shown when onPin is provided (i.e. pin has effect on ordering) */}
          <div className="relative h-3.5 w-3.5 flex-shrink-0">
            {onPin &&
            thread.pinned &&
            thread.status !== 'running' &&
            thread.status !== 'setting_up' ? (
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center text-muted-foreground',
                  'group-hover/thread:hidden',
                )}
              >
                <Pin className="icon-sm" />
              </span>
            ) : (
              <span className={cn('absolute inset-0', onPin && 'group-hover/thread:hidden')}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <StatusIcon className={cn('icon-sm', threadStatusCfg.className)} />
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
                {thread.pinned ? <PinOff className="icon-sm" /> : <Pin className="icon-sm" />}
              </span>
            )}
          </div>
          <span className="truncate text-sm leading-tight">{thread.title}</span>
          {/* External creator icon */}
          {thread.createdBy && thread.createdBy !== 'user' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Bot className="icon-xs flex-shrink-0 text-muted-foreground" />
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

        {/* Row 2: Powerline (project → branch) + Git status + Snippet + Time */}
        {(hasMetadataRow || hasSnippetRow || powerlineSegments.length > 0) && (
          <div className="flex min-w-0 items-center gap-1.5 pl-5">
            {powerlineSegments.length > 0 && (
              <PowerlineBar
                segments={powerlineSegments}
                size="sm"
                className="min-w-0 flex-shrink"
                data-testid={`thread-powerline-${thread.id}`}
              />
            )}
            {hasDiffStats && (
              <DiffStats
                linesAdded={effectiveGitStatus.linesAdded}
                linesDeleted={effectiveGitStatus.linesDeleted}
                dirtyFileCount={effectiveGitStatus.dirtyFileCount}
                size="xs"
              />
            )}
            {hasPR &&
              effectiveGitStatus &&
              (() => {
                const prState = effectiveGitStatus.prState ?? 'OPEN';
                const PrIcon =
                  prState === 'MERGED'
                    ? GitMerge
                    : prState === 'CLOSED'
                      ? GitPullRequestClosed
                      : GitPullRequest;
                const prColor =
                  prState === 'MERGED'
                    ? 'text-purple-500 hover:text-purple-400'
                    : prState === 'CLOSED'
                      ? 'text-red-500 hover:text-red-400'
                      : 'text-green-500 hover:text-green-400';
                const prLabel =
                  prState === 'MERGED'
                    ? t('thread.prMerged', {
                        number: effectiveGitStatus.prNumber,
                        defaultValue: `PR #${effectiveGitStatus.prNumber} (merged)`,
                      })
                    : prState === 'CLOSED'
                      ? t('thread.prClosed', {
                          number: effectiveGitStatus.prNumber,
                          defaultValue: `PR #${effectiveGitStatus.prNumber} (closed)`,
                        })
                      : t('thread.prOpen', {
                          number: effectiveGitStatus.prNumber,
                          defaultValue: `PR #${effectiveGitStatus.prNumber}`,
                        });
                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <a
                        href={effectiveGitStatus.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className={`flex flex-shrink-0 items-center gap-0.5 text-xs ${prColor}`}
                        data-testid={`thread-pr-badge-${thread.id}`}
                      >
                        <PrIcon className="icon-xs" />
                        <span>#{effectiveGitStatus.prNumber}</span>
                      </a>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                      {prLabel}
                    </TooltipContent>
                  </Tooltip>
                );
              })()}
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
                  <MoreVertical className="icon-sm" />
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
                  <FolderOpenDot className="icon-sm" />
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
                  <Terminal className="icon-sm" />
                  {t('sidebar.openTerminal')}
                </DropdownMenuItem>
                {onRename && (
                  <DropdownMenuItem
                    data-testid={`thread-rename-${thread.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      openRenameDialog();
                    }}
                  >
                    <Pencil className="icon-sm" />
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
                      <Square className="icon-sm" />
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
                    <Archive className="icon-sm" />
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
                      <Trash2 className="icon-sm" />
                      {t('common.delete')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Rename dialog */}
      <Dialog open={isRenameOpen} onOpenChange={setIsRenameOpen}>
        <DialogContent className="sm:max-w-md" data-testid={`thread-rename-dialog-${thread.id}`}>
          <DialogHeader>
            <DialogTitle>{t('sidebar.rename')}</DialogTitle>
          </DialogHeader>
          <Input
            data-testid={`thread-rename-input-${thread.id}`}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
            }}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setIsRenameOpen(false)}
              data-testid="thread-rename-cancel"
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={commitRename}
              disabled={!renameValue.trim() || renameValue.trim() === thread.title}
              data-testid="thread-rename-confirm"
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}, threadItemAreEqual);
