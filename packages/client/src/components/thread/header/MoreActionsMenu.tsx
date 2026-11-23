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
  const { t } = useTranslation();
  const setShareDialogOpen = useUIStore((s) => s.setShareDialogOpen);
  const {
    threadId,
    threadStage,
    hasMessages,
    isScratchThread,
    canConvertToWorktree,
    showStage,
    threadPinned,
    activityActive,
    timelineVisible,
    copiedText,
    copiedTools,
    setDeleteOpen,
    setCreateBranchOpen,
    handleConvertToWorktree,
    handleCopy,
    handleOpenInEditor,
    handleStageChange,
    handleViewOnBoard,
    togglePin,
    toggleActivity,
    toggleTimeline,
  } = menu;
  const effectiveOpenInEditor = onOpenInEditor ?? handleOpenInEditor;
  const effectiveViewOnBoard = onViewOnBoard ?? handleViewOnBoard;
  return (
    <>
      {(showStage || (threadId && !isScratchThread)) && (
        <>
          {showStage && threadStage && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="header-menu-stage">
                {(() => {
                  const StageIcon = stageConfig[threadStage].icon;
                  return <StageIcon className="icon-base mr-2" />;
                })()}
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
          {threadId && !isScratchThread && (
            <DropdownMenuItem
              data-testid="header-menu-view-board"
              onClick={effectiveViewOnBoard}
              className="cursor-pointer"
            >
              <Columns3 className="icon-base mr-2" />
              {t('kanban.viewOnBoard', 'View on Board')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem
        data-testid="header-menu-toggle-activity"
        onClick={() => startTransition(toggleActivity)}
        className="cursor-pointer"
      >
        <Activity className={`icon-base mr-2 ${activityActive ? 'text-primary' : ''}`} />
        {t('activity.title', 'Activity')}
      </DropdownMenuItem>
      {threadId && !hideTimeline && (
        <DropdownMenuItem
          data-testid="header-menu-toggle-timeline"
          onClick={toggleTimeline}
          className="cursor-pointer"
        >
          <Milestone className={`icon-base mr-2 ${timelineVisible ? 'text-primary' : ''}`} />
          {t('thread.toggleTimeline', 'Toggle Timeline')}
        </DropdownMenuItem>
      )}
      {(comments || canShare) && (
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
                  comments.active ? 'text-primary' : comments.count > 0 && 'text-status-info',
                )}
              />
              {t('comments.title', 'Comments')}
              {comments.count > 0 && (
                <span
                  className="bg-status-info text-3xs ml-2 flex h-4 min-w-4 items-center justify-center rounded-full px-1 leading-none font-medium text-white"
                  data-testid="comments-badge"
                >
                  {comments.count > 99 ? '99+' : comments.count}
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
      )}
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
      {!isScratchThread && (
        <HostOpenInEditorSubmenu testId="header-menu-open-editor" onPick={effectiveOpenInEditor} />
      )}
      {threadId && canConvertToWorktree && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="header-menu-convert-worktree"
            onClick={handleConvertToWorktree}
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
      {threadId && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="header-menu-pin"
            onClick={togglePin}
            className="cursor-pointer"
          >
            {threadPinned ? (
              <>
                <PinOff className="icon-base mr-2" />
                {t('sidebar.unpin', 'Unpin')}
              </>
            ) : (
              <>
                <Pin className="icon-base mr-2" />
                {t('sidebar.pin', 'Pin')}
              </>
            )}
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
      )}
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
              <Button
                data-testid="header-more-actions"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
              >
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
