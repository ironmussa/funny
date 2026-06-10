import type { Thread, GitStatusInfo } from '@funny/shared';
import {
  Archive,
  Trash2,
  MoreVertical,
  FolderOpenDot,
  Terminal,
  Square,
  Bot,
  Pencil,
  GitFork,
  GitBranch,
  Loader2,
  NotebookPen,
} from 'lucide-react';
import { useState, memo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { PRBadge } from '@/components/PRBadge';
import { ThreadTitle } from '@/components/thread/ThreadAttachmentsBadge';
import { ThreadStatusPin } from '@/components/thread/ThreadStatusPin';
import { ThreadPowerline } from '@/components/ThreadPowerline';
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
import { HoverTimeMenu } from '@/components/ui/hover-time-menu';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { openThreadTerminal } from '@/lib/open-terminal-tab';
import { threadsVisuallyEqual } from '@/lib/shallow-compare';
import { timeAgo } from '@/lib/thread-utils';
import {
  canConvertToWorktree,
  canShowPowerline,
  getThreadRoute,
  isScratch,
} from '@/lib/thread-variant';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useThreadStore } from '@/stores/thread-store';

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
  href?: string;
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
  if (prev.href !== next.href) return false;
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
  href,
}: ThreadItemProps) {
  const { t } = useTranslation();
  const [openDropdown, setOpenDropdown] = useState(false);
  const handleDropdownChange = useCallback((open: boolean) => setOpenDropdown(open), []);

  // Rename dialog state
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  // Agent template lookup for badge display
  const agentTemplate = useAgentTemplateStore((s) =>
    thread.agentTemplateId ? s.templates.find((t) => t.id === thread.agentTemplateId) : undefined,
  );

  // Create Branch dialog state
  const [isCreateBranchOpen, setIsCreateBranchOpen] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [createBranchLoading, setCreateBranchLoading] = useState(false);

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

  const commitCreateBranch = useCallback(async () => {
    const name = branchName
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9\-_/.]/g, '');
    if (!name || !thread.projectId) return;
    setCreateBranchLoading(true);
    const result = await api.checkout(thread.projectId, name, 'carry', true, thread.id);
    setCreateBranchLoading(false);
    if (result.isErr()) {
      toastError(result.error);
    } else {
      setIsCreateBranchOpen(false);
      setBranchName('');
    }
  }, [branchName, thread.projectId, thread.id]);

  // Thread status (used for busy checks + dropdown gating)
  const isRunning = thread.status === 'running';
  const isSettingUp = thread.status === 'setting_up';
  const isBusy = isRunning || isSettingUp;
  const displayTime = timeValue ?? timeAgo(thread.createdAt, t);
  const threadHref = href ?? buildPath(getThreadRoute(thread));

  // Keep the last known git status so the widget doesn't flicker away
  // during transient undefined gaps (e.g. thread selection race conditions).
  const lastGitStatusRef = useRef(gitStatus);
  if (gitStatus) lastGitStatusRef.current = gitStatus;
  const effectiveGitStatus = gitStatus ?? lastGitStatusRef.current;

  // Whether to show the second row (has project subtitle or git diff stats)
  const hasDiffStats =
    !!effectiveGitStatus &&
    effectiveGitStatus.state !== 'clean' &&
    (effectiveGitStatus.linesAdded > 0 ||
      effectiveGitStatus.linesDeleted > 0 ||
      effectiveGitStatus.dirtyFileCount > 0);
  const hasPR = !!effectiveGitStatus?.prNumber;
  const hasSnippet = !!thread.lastAssistantMessage;
  const showLaunching = isBusy && !hasSnippet;
  const isBacklog = !hasSnippet && !isBusy && (!thread.stage || thread.stage === 'backlog');
  // Scratch threads have no project / branch / worktree — never show the
  // powerline even if older DB rows still carry a stale `branch` value.
  // Instead they get a scratch-pad icon as the row's identifier.
  const scratch = isScratch(thread);
  const hasPowerline =
    canShowPowerline(thread) && (!!subtitle || !!thread.baseBranch || !!thread.branch);
  const hasMetadataRow = hasDiffStats || hasPR || hasPowerline || scratch;
  const hasSnippetRow = hasSnippet || showLaunching || isBacklog;

  return (
    <div
      className={cn(
        'group/thread w-full flex items-stretch rounded-md min-w-0',
        isSelected
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <div
        role="button"
        tabIndex={0}
        data-testid={`thread-item-${thread.id}`}
        onPointerEnter={() => {
          if (!isSelected) useThreadStore.getState().prefetchThread(thread.id);
        }}
        onFocus={() => {
          if (!isSelected) useThreadStore.getState().prefetchThread(thread.id);
        }}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            e.stopPropagation();
            window.open(
              threadHref,
              '_blank',
              'noopener,noreferrer,popup=yes,width=1280,height=900',
            );
            return;
          }
          onSelect();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        onAuxClick={(e) => {
          // Middle-click also opens in a new window for consistency
          if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            window.open(
              threadHref,
              '_blank',
              'noopener,noreferrer,popup=yes,width=1280,height=900',
            );
          }
        }}
        className="focus-visible:ring-ring flex min-w-0 flex-1 cursor-pointer flex-col gap-1 overflow-hidden py-1.5 pl-2 text-left focus:outline-hidden focus-visible:ring-1"
      >
        {/* Row 1: Status icon + Title */}
        <div className="flex min-w-0 items-center gap-1.5">
          {/* Thread status / pin icon — pin only shown when onPin is provided */}
          <ThreadStatusPin
            thread={thread}
            onPin={onPin ? () => onPin() : undefined}
            hoverGroup="thread"
            showStatusTooltip
          />

          <ThreadTitle
            title={thread.title}
            className="text-sm leading-tight"
            badgeTestId={`thread-item-attachments-${thread.id}`}
          />
          {/* External creator icon */}
          {thread.createdBy && thread.createdBy !== 'user' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Bot className="icon-xs text-muted-foreground shrink-0" />
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {t('thread.createdBy', { creator: thread.createdBy })}
              </TooltipContent>
            </Tooltip>
          )}
          {/* Remote runtime badge */}
          {thread.runtime === 'remote' && (
            <span className="shrink-0 rounded bg-violet-500/15 px-1 py-0.5 text-[10px] leading-none font-medium text-violet-500">
              Remote
            </span>
          )}
          {/* Agent template badge */}
          {agentTemplate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] leading-none font-medium"
                  style={{
                    backgroundColor: agentTemplate.color
                      ? `${agentTemplate.color}22`
                      : 'hsl(var(--muted))',
                    color: agentTemplate.color ?? 'hsl(var(--muted-foreground))',
                  }}
                  data-testid={`thread-template-badge-${thread.id}`}
                >
                  {agentTemplate.color && (
                    <span
                      className="inline-block size-1.5 rounded-full"
                      style={{ backgroundColor: agentTemplate.color }}
                    />
                  )}
                  {agentTemplate.name}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {agentTemplate.description || agentTemplate.name}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Row 2: Powerline (project → branch) + Git status + Snippet + Time */}
        {(hasMetadataRow || hasSnippetRow) && (
          <div className="flex min-h-[22px] min-w-0 items-center gap-1.5 pl-5">
            {hasPowerline && (
              <ThreadPowerline
                thread={thread}
                projectName={subtitle}
                projectColor={projectColor}
                projectTooltip={projectPath}
                gitStatus={effectiveGitStatus}
                diffStatsSize="xs"
                data-testid={`thread-powerline-${thread.id}`}
              />
            )}
            {scratch && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    data-testid={`thread-scratch-badge-${thread.id}`}
                    className="bg-muted/60 text-muted-foreground flex shrink-0 items-center rounded p-1 leading-none"
                  >
                    <NotebookPen className="icon-xs" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {t('thread.scratchTooltip', {
                    defaultValue: 'Scratch thread — no project, no git',
                  })}
                </TooltipContent>
              </Tooltip>
            )}
            {hasPR && effectiveGitStatus && (
              <PRBadge
                prNumber={effectiveGitStatus.prNumber!}
                prState={effectiveGitStatus.prState ?? 'OPEN'}
                prUrl={effectiveGitStatus.prUrl}
                size="xs"
                data-testid={`thread-pr-badge-${thread.id}`}
              />
            )}
            {hasSnippet ? (
              <span className="text-muted-foreground/50 min-w-0 flex-1 truncate text-xs">
                {thread.lastAssistantMessage}
              </span>
            ) : showLaunching ? (
              <span className="text-muted-foreground/50 min-w-0 flex-1 truncate text-xs italic">
                {t('thread.launching', 'Launching...')}
              </span>
            ) : isBacklog ? (
              <span className="text-muted-foreground/50 min-w-0 flex-1 truncate text-xs italic">
                {t('thread.readyToLaunch', 'Ready to Launch')}
              </span>
            ) : null}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 py-1 pr-1.5 pl-2">
        <HoverTimeMenu
          time={displayTime}
          timeClassName="text-muted-foreground h-4 text-xs leading-4"
          open={openDropdown}
          group="thread"
          className="min-w-10"
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
                  const result = await api.openDirectory({
                    threadId: thread.id,
                  });
                  if (result.isErr()) {
                    toastError(result.error);
                  }
                }}
              >
                <FolderOpenDot className="icon-sm" />
                {t('sidebar.openDirectory')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  openThreadTerminal({ thread });
                }}
              >
                <Terminal className="icon-sm" />
                {t('sidebar.openTerminal')}
              </DropdownMenuItem>
              {canConvertToWorktree(thread) && !isBusy && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid={`thread-convert-worktree-${thread.id}`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      const result = await api.convertToWorktree(thread.id);
                      if (result.isErr()) {
                        toastError(result.error);
                      }
                    }}
                  >
                    <GitFork className="icon-sm" />
                    {t('dialog.convertToWorktreeTitle')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid={`thread-create-branch-${thread.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsCreateBranchOpen(true);
                    }}
                  >
                    <GitBranch className="icon-sm" />
                    {t('dialog.createBranchTitle')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
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
        </HoverTimeMenu>
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

      {/* Create Branch dialog */}
      <Dialog open={isCreateBranchOpen} onOpenChange={setIsCreateBranchOpen}>
        <DialogContent
          className="sm:max-w-md"
          data-testid={`thread-create-branch-dialog-${thread.id}`}
        >
          <DialogHeader>
            <DialogTitle>{t('dialog.createBranchTitle')}</DialogTitle>
          </DialogHeader>
          <Input
            data-testid={`thread-create-branch-input-${thread.id}`}
            placeholder={t('dialog.createBranchPlaceholder')}
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && branchName.trim()) commitCreateBranch();
            }}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setIsCreateBranchOpen(false)}
              data-testid={`thread-create-branch-cancel-${thread.id}`}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={commitCreateBranch}
              disabled={!branchName.trim() || createBranchLoading}
              data-testid={`thread-create-branch-confirm-${thread.id}`}
            >
              {createBranchLoading ? (
                <Loader2 className="icon-sm animate-spin" />
              ) : (
                t('common.create', 'Create')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}, threadItemAreEqual);
