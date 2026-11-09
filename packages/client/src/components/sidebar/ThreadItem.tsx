import type { Thread, GitStatusInfo } from '@funny/shared';
import {
  Archive,
  Trash2,
  MoreVertical,
  FolderOpenDot,
  Terminal,
  Square,
  Pencil,
  GitFork,
  GitBranch,
} from 'lucide-react';
import { useState, memo, useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ThreadStatusPin } from '@/components/thread/ThreadStatusPin';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { HoverTimeMenu } from '@/components/ui/hover-time-menu';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { api } from '@/lib/api';
import { openThreadTerminal } from '@/lib/open-terminal-tab';
import { threadsVisuallyEqual } from '@/lib/shallow-compare';
import { timeAgo } from '@/lib/thread-utils';
import { canConvertToWorktree, getThreadRoute } from '@/lib/thread-variant';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useThreadStore } from '@/stores/thread-store';

import {
  CreateBranchDialog,
  RenameThreadDialog,
  useCreateBranchDialog,
  useRenameThreadDialog,
} from './ThreadItemDialogs';
import { ThreadItemMetaRow, ThreadItemTitleRow } from './ThreadItemRows';

export interface ThreadItemProps {
  thread: Thread;
  projectPath: string;
  isSelected: boolean;
  onSelect: () => void;
  subtitle?: string;
  projectColor?: string;
  timeValue?: string;
  search?: string;
  contentSnippet?: string;
  titleBadge?: ReactNode;
  metadataBadge?: ReactNode;
  hideActions?: boolean;
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
const THREAD_ITEM_COMPARED_PROPS = [
  'isSelected',
  'onSelect',
  'onRename',
  'onArchive',
  'onPin',
  'onDelete',
  'subtitle',
  'projectColor',
  'timeValue',
  'search',
  'contentSnippet',
  'titleBadge',
  'metadataBadge',
  'hideActions',
  'projectPath',
  'gitStatus',
  'href',
] as const satisfies readonly (keyof ThreadItemProps)[];

function threadItemAreEqual(prev: ThreadItemProps, next: ThreadItemProps): boolean {
  if (THREAD_ITEM_COMPARED_PROPS.some((key) => prev[key] !== next[key])) return false;
  return threadsVisuallyEqual(prev.thread, next.thread);
}

interface ThreadItemActionsProps {
  thread: Thread;
  displayTime: string;
  isBusy: boolean;
  isRunning: boolean;
  onRename?: () => void;
  onCreateBranch: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}

function ThreadItemActions({
  thread,
  displayTime,
  isBusy,
  isRunning,
  onRename,
  onCreateBranch,
  onArchive,
  onDelete,
}: ThreadItemActionsProps) {
  const { t } = useTranslation();
  const [openDropdown, setOpenDropdown] = useState(false);
  const handleDropdownChange = useCallback((open: boolean) => setOpenDropdown(open), []);

  return (
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
                  onCreateBranch();
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
                onRename();
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
  );
}

const NEW_WINDOW_FEATURES = 'noopener,noreferrer,popup=yes,width=1280,height=900';

function openThreadInNewWindow(e: React.MouseEvent, href: string) {
  e.preventDefault();
  e.stopPropagation();
  window.open(href, '_blank', NEW_WINDOW_FEATURES);
}

/** Pointer / keyboard handlers for the row's selection button. */
function useThreadRowHandlers(
  threadId: string,
  isSelected: boolean,
  threadHref: string,
  onSelect: () => void,
) {
  const prefetch = () => {
    if (!isSelected) useThreadStore.getState().prefetchThread(threadId);
  };
  return {
    onPointerEnter: prefetch,
    onFocus: prefetch,
    onClick: (e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey) {
        openThreadInNewWindow(e, threadHref);
        return;
      }
      onSelect();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect();
      }
    },
    // Middle-click also opens in a new window for consistency
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button === 1) openThreadInNewWindow(e, threadHref);
    },
  };
}

/**
 * Keep the last known git status so the widget doesn't flicker away during
 * transient undefined gaps (e.g. thread selection race conditions).
 */
function useStickyGitStatus(gitStatus?: GitStatusInfo) {
  const lastGitStatusRef = useRef(gitStatus);
  const effectiveGitStatus = gitStatus ?? lastGitStatusRef.current;
  useLayoutEffect(() => {
    if (gitStatus) lastGitStatusRef.current = gitStatus;
  }, [gitStatus]);
  return effectiveGitStatus;
}

interface ThreadItemTrailingProps {
  thread: Thread;
  displayTime: string;
  hideActions: boolean;
  onRename?: () => void;
  onCreateBranch: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}

function ThreadItemTrailing({
  hideActions,
  displayTime,
  thread,
  ...actions
}: ThreadItemTrailingProps) {
  // Thread status (used for busy checks + dropdown gating)
  const isRunning = thread.status === 'running';
  const isBusy = isRunning || thread.status === 'setting_up';
  return (
    <div className="flex shrink-0 items-center gap-1.5 py-1 pr-1.5 pl-2">
      {hideActions ? (
        <span className="text-muted-foreground h-4 min-w-10 text-right text-xs leading-4">
          {displayTime}
        </span>
      ) : (
        <ThreadItemActions
          thread={thread}
          displayTime={displayTime}
          isBusy={isBusy}
          isRunning={isRunning}
          {...actions}
        />
      )}
    </div>
  );
}

/** All of a row's hooks + derived values, kept out of the render body. */
function useThreadItemState({
  thread,
  isSelected,
  onSelect,
  timeValue,
  gitStatus,
  href,
  onRename,
  onPin,
}: Pick<
  ThreadItemProps,
  'thread' | 'isSelected' | 'onSelect' | 'timeValue' | 'gitStatus' | 'href' | 'onRename' | 'onPin'
>) {
  const { t } = useTranslation();
  const now = useMinuteTick();
  const renameDialog = useRenameThreadDialog(thread.title, onRename);
  const createBranchDialog = useCreateBranchDialog(thread.id, thread.projectId);
  const effectiveGitStatus = useStickyGitStatus(gitStatus);

  const displayTime = timeValue ?? timeAgo(thread.createdAt, t, now);
  const threadHref = href ?? buildPath(getThreadRoute(thread));
  const rowHandlers = useThreadRowHandlers(thread.id, isSelected, threadHref, onSelect);

  return {
    displayTime,
    effectiveGitStatus,
    rowHandlers,
    rowClassName: isSelected
      ? 'bg-accent text-foreground'
      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
    handlePin: onPin ? () => onPin() : undefined,
    handleRename: onRename ? renameDialog.openDialog : undefined,
    renameDialog,
    createBranchDialog,
  };
}

export const ThreadItem = memo(function ThreadItem({
  thread,
  projectPath,
  isSelected,
  onSelect,
  subtitle,
  projectColor,
  timeValue,
  search,
  contentSnippet,
  titleBadge,
  metadataBadge,
  hideActions = false,
  onRename,
  onArchive,
  onPin,
  onDelete,
  gitStatus,
  href,
}: ThreadItemProps) {
  const {
    displayTime,
    effectiveGitStatus,
    rowHandlers,
    rowClassName,
    handlePin,
    handleRename,
    renameDialog,
    createBranchDialog,
  } = useThreadItemState({
    thread,
    isSelected,
    onSelect,
    timeValue,
    gitStatus,
    href,
    onRename,
    onPin,
  });

  return (
    <div className={cn('group/thread w-full flex items-stretch rounded-md min-w-0', rowClassName)}>
      {/* Keep the pin beside the selection button so interactive elements are never nested. */}
      <div className="shrink-0 py-2 pl-2">
        <ThreadStatusPin thread={thread} onPin={handlePin} hoverGroup="thread" showStatusTooltip />
      </div>

      <button
        type="button"
        data-testid={`thread-item-${thread.id}`}
        {...rowHandlers}
        className="focus-visible:ring-ring flex min-w-0 flex-1 cursor-pointer flex-col gap-1 overflow-hidden bg-transparent py-1.5 pl-1.5 text-left focus:outline-hidden focus-visible:ring-1"
      >
        {/* Row 1: Title */}
        <ThreadItemTitleRow
          thread={thread}
          search={search}
          titleBadge={titleBadge}
          gitStatus={effectiveGitStatus}
        />

        {/* Row 2: Powerline (project → branch) + Snippet */}
        <ThreadItemMetaRow
          thread={thread}
          subtitle={subtitle}
          projectColor={projectColor}
          projectPath={projectPath}
          gitStatus={effectiveGitStatus}
          metadataBadge={metadataBadge}
          contentSnippet={contentSnippet}
          search={search}
        />
      </button>
      <ThreadItemTrailing
        thread={thread}
        displayTime={displayTime}
        hideActions={hideActions}
        onRename={handleRename}
        onCreateBranch={createBranchDialog.openDialog}
        onArchive={onArchive}
        onDelete={onDelete}
      />

      <RenameThreadDialog thread={thread} dialog={renameDialog} />
      <CreateBranchDialog thread={thread} dialog={createBranchDialog} />
    </div>
  );
}, threadItemAreEqual);
