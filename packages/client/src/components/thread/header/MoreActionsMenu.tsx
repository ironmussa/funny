import type { ThreadStage } from '@funny/shared';
import {
  Activity,
  Check,
  ClipboardList,
  Columns3,
  Copy,
  EllipsisVertical,
  GitBranch,
  GitFork,
  MessageSquare,
  Milestone,
  Pin,
  PinOff,
  Share2,
  Trash2,
} from 'lucide-react';
import { memo, startTransition } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CreateBranchDialog } from '@/components/CreateBranchDialog';
import { HostOpenInEditorSubmenu } from '@/components/HostOnly';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { stageConfig } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import type { Editor } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

import type { CommentsMenuAction } from './ThreadHeaderActions';
import { useMoreActionsMenu } from './use-more-actions-menu';

interface Props {
  hideTimeline?: boolean;
  onOpenInEditor?: (editor: Editor) => void;
  onViewOnBoard?: () => void;
  comments?: CommentsMenuAction;
  canShare?: boolean;
}

type Menu = ReturnType<typeof useMoreActionsMenu>;
const VISIBLE_STAGES: ThreadStage[] = [
  'backlog',
  'planning',
  'in_progress',
  'review',
  'done',
  'archived',
];

/** The thread's stage submenu and the board link (hidden for scratch threads). */
function StageSection({ menu, onViewOnBoard }: { menu: Menu; onViewOnBoard: () => void }) {
  const { t } = useTranslation();
  const { threadId, threadStage, isScratchThread, showStage, handleStageChange } = menu;
  const onBoard = !!threadId && !isScratchThread;
  if (!showStage && !onBoard) return null;
  const StageIcon = threadStage ? stageConfig[threadStage].icon : null;
  return (
    <>
      {showStage && threadStage && StageIcon && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="header-menu-stage">
            <StageIcon className="icon-base mr-2" />
            {t('kanban.stage', 'Stage')}
            <span className="text-muted-foreground ml-auto pl-2 text-xs">
              {t(stageConfig[threadStage].labelKey)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent>
              {VISIBLE_STAGES.map((stage) => {
                const Icon = stageConfig[stage].icon;
                return (
                  <DropdownMenuItem
                    key={stage}
                    data-testid={`header-menu-stage-${stage}`}
                    onClick={() => handleStageChange(stage)}
                    className="cursor-pointer"
                  >
                    <Icon className="icon-base mr-2" />
                    {t(stageConfig[stage].labelKey)}
                    {stage === threadStage && (
                      <Check className="icon-base text-status-success ml-auto pl-1" />
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
      )}
      {onBoard && (
        <DropdownMenuItem
          data-testid="header-menu-view-board"
          onClick={onViewOnBoard}
          className="cursor-pointer"
        >
          <Columns3 className="icon-base mr-2" />
          {t('kanban.viewOnBoard', 'View on Board')}
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
    </>
  );
}

/** The activity panel and the timeline toggles. */
function ViewSection({ menu, hideTimeline }: { menu: Menu; hideTimeline: boolean }) {
  const { t } = useTranslation();
  const { threadId, activityActive, timelineVisible, toggleActivity, toggleTimeline } = menu;
  return (
    <>
      <DropdownMenuItem
        data-testid="header-menu-toggle-activity"
        onClick={() => startTransition(toggleActivity)}
        className="cursor-pointer"
      >
        <Activity className={cn('icon-base mr-2', activityActive && 'text-primary')} />
        {t('activity.title', 'Activity')}
      </DropdownMenuItem>
      {threadId && !hideTimeline && (
        <DropdownMenuItem
          data-testid="header-menu-toggle-timeline"
          onClick={toggleTimeline}
          className="cursor-pointer"
        >
          <Milestone className={cn('icon-base mr-2', timelineVisible && 'text-primary')} />
          {t('thread.toggleTimeline', 'Toggle Timeline')}
        </DropdownMenuItem>
      )}
    </>
  );
}

/** The comment count badge: up to 99, then "99+". */
const commentCountLabel = (count: number) => (count > 99 ? '99+' : count);

/** The thread's comments panel and its share dialog. */
function CommentsShareSection({
  comments,
  canShare,
}: {
  comments?: CommentsMenuAction;
  canShare: boolean;
}) {
  const { t } = useTranslation();
  const setShareDialogOpen = useUIStore((s) => s.setShareDialogOpen);
  if (!comments && !canShare) return null;
  const hasComments = !!comments && comments.count > 0;
  return (
    <>
      <DropdownMenuSeparator />
      {comments && (
        <DropdownMenuItem
          data-testid="header-menu-toggle-comments"
          onClick={comments.onToggle}
          className="cursor-pointer"
        >
          <MessageSquare
            className={cn(
              'icon-base mr-2',
              comments.active ? 'text-primary' : hasComments && 'text-status-info',
            )}
          />
          {t('comments.title', 'Comments')}
          {hasComments && (
            <span
              className="bg-status-info text-3xs ml-2 flex h-4 min-w-4 items-center justify-center rounded-full px-1 leading-none font-medium text-white"
              data-testid="comments-badge"
            >
              {commentCountLabel(comments.count)}
            </span>
          )}
          <span className="text-muted-foreground ml-auto pl-4 text-xs">Alt+M</span>
        </DropdownMenuItem>
      )}
      {canShare && (
        <DropdownMenuItem
          data-testid="header-menu-share"
          onClick={() => setShareDialogOpen(true)}
          className="cursor-pointer"
        >
          <Share2 className="icon-base mr-2" />
          {t('thread.share', 'Share thread')}
          <span className="text-muted-foreground ml-auto pl-4 text-xs">Alt+H</span>
        </DropdownMenuItem>
      )}
    </>
  );
}

/** Copy the conversation, with or without its tool calls. */
function CopySection({ menu }: { menu: Menu }) {
  const { t } = useTranslation();
  const { hasMessages, copiedText, copiedTools, handleCopy } = menu;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid="header-menu-copy-text"
        onClick={() => handleCopy(false)}
        disabled={!hasMessages}
        className="cursor-pointer"
      >
        {copiedText ? (
          <Check className="icon-base copy-feedback-icon text-status-success mr-2" />
        ) : (
          <Copy className="icon-base copy-feedback-icon mr-2" />
        )}
        {t('thread.copyText', 'Copy text only')}
      </DropdownMenuItem>
      <DropdownMenuItem
        data-testid="header-menu-copy-all"
        onClick={() => handleCopy(true)}
        disabled={!hasMessages}
        className="cursor-pointer"
      >
        {copiedTools ? (
          <Check className="icon-base copy-feedback-icon text-status-success mr-2" />
        ) : (
          <ClipboardList className="icon-base copy-feedback-icon mr-2" />
        )}
        {t('thread.copyWithTools', 'Copy with tool calls')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

/** Open in an editor, and turn a local thread into a worktree or a branch. */
function WorkspaceSection({
  menu,
  onOpenInEditor,
}: {
  menu: Menu;
  onOpenInEditor: (editor: Editor) => void;
}) {
  const { t } = useTranslation();
  const { threadId, isScratchThread, canConvertToWorktree, setCreateBranchOpen } = menu;
  return (
    <>
      {!isScratchThread && (
        <HostOpenInEditorSubmenu testId="header-menu-open-editor" onPick={onOpenInEditor} />
      )}
      {threadId && canConvertToWorktree && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="header-menu-convert-worktree"
            onClick={menu.handleConvertToWorktree}
            className="cursor-pointer"
          >
            <GitFork className="icon-base mr-2" />
            {t('dialog.convertToWorktreeTitle')}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="header-menu-create-branch"
            onClick={() => setCreateBranchOpen(true)}
            className="cursor-pointer"
          >
            <GitBranch className="icon-base mr-2" />
            {t('dialog.createBranchTitle')}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

/** Pin the thread, and delete it. */
function PinDeleteSection({ menu }: { menu: Menu }) {
  const { t } = useTranslation();
  const { threadId, threadPinned, togglePin, setDeleteOpen } = menu;
  if (!threadId) return null;
  const PinIcon = threadPinned ? PinOff : Pin;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid="header-menu-pin"
        onClick={togglePin}
        className="cursor-pointer"
      >
        <PinIcon className="icon-base mr-2" />
        {threadPinned ? t('sidebar.unpin', 'Unpin') : t('sidebar.pin', 'Pin')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid="header-menu-delete"
        onClick={() => setDeleteOpen(true)}
        className="text-status-error focus:text-status-error cursor-pointer"
      >
        <Trash2 className="icon-base mr-2" />
        {t('common.delete', 'Delete')}
      </DropdownMenuItem>
    </>
  );
}

function MenuItems({
  hideTimeline = false,
  menu,
  onOpenInEditor,
  onViewOnBoard,
  comments,
  canShare = false,
}: {
  hideTimeline?: boolean;
  menu: Menu;
  onOpenInEditor?: (editor: Editor) => void;
  onViewOnBoard?: () => void;
  comments?: CommentsMenuAction;
  canShare?: boolean;
}) {
  return (
    <>
      <StageSection menu={menu} onViewOnBoard={onViewOnBoard ?? menu.handleViewOnBoard} />
      <ViewSection menu={menu} hideTimeline={hideTimeline} />
      <CommentsShareSection comments={comments} canShare={canShare} />
      <CopySection menu={menu} />
      <WorkspaceSection menu={menu} onOpenInEditor={onOpenInEditor ?? menu.handleOpenInEditor} />
      <PinDeleteSection menu={menu} />
    </>
  );
}

/**
 * The "more actions" (•••) dropdown shown at the right of the thread header.
 * Stores live in `useMoreActionsMenu`; this component is JSX-only.
 *
 * Extracted from ProjectHeader.tsx as part of the god-file split.
 */
export const MoreActionsMenu = memo(function MoreActionsMenu({
  hideTimeline = false,
  onOpenInEditor,
  onViewOnBoard,
  comments,
  canShare,
}: Props) {
  const { t } = useTranslation();
  const menu = useMoreActionsMenu();
  const {
    threadTitle,
    isWorktree,
    sourceBranch,
    deleteOpen,
    setDeleteOpen,
    deleteLoading,
    createBranchOpen,
    setCreateBranchOpen,
    createBranchLoading,
    tooltipMenu,
    handleCreateBranch,
    handleDeleteConfirm,
  } = menu;
  return (
    <>
      <DropdownMenu {...tooltipMenu.menuProps}>
        <Tooltip {...tooltipMenu.tooltipProps}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button data-testid="header-more-actions" variant="muted" size="icon-sm">
                <EllipsisVertical className="icon-base" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t('thread.moreActions', 'More actions')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" {...tooltipMenu.contentProps}>
          <MenuItems
            hideTimeline={hideTimeline}
            menu={menu}
            onOpenInEditor={onOpenInEditor}
            onViewOnBoard={onViewOnBoard}
            comments={comments}
            canShare={canShare}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open) setDeleteOpen(false);
        }}
        title={t('dialog.deleteThread')}
        description={t('dialog.deleteThreadDesc', {
          title:
            threadTitle && threadTitle.length > 80 ? threadTitle.slice(0, 80) + '…' : threadTitle,
        })}
        warning={isWorktree ? t('dialog.worktreeWarning') : undefined}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.delete')}
        loading={deleteLoading}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={handleDeleteConfirm}
      />
      <CreateBranchDialog
        open={createBranchOpen}
        onOpenChange={setCreateBranchOpen}
        sourceBranch={sourceBranch}
        threadTitle={threadTitle}
        loading={createBranchLoading}
        onCreate={handleCreateBranch}
      />
    </>
  );
});
