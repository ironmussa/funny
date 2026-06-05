import {
  Activity,
  Check,
  ClipboardList,
  Columns3,
  Copy,
  EllipsisVertical,
  GitBranch,
  GitFork,
  Milestone,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { memo, startTransition } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CreateBranchDialog } from '@/components/CreateBranchDialog';
import { OpenInEditorSubmenu } from '@/components/OpenInEditorSubmenu';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { useMoreActionsMenu } from './use-more-actions-menu';

interface Props {
  onViewOnBoard?: () => void;
}

type Menu = ReturnType<typeof useMoreActionsMenu>;

function MenuItems({ menu, onViewOnBoard }: { menu: Menu; onViewOnBoard?: () => void }) {
  const { t } = useTranslation();
  const {
    threadId,
    hasMessages,
    canConvertToWorktree,
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
    togglePin,
    toggleActivity,
    toggleTimeline,
  } = menu;
  return (
    <>
      {onViewOnBoard && (
        <>
          <DropdownMenuItem
            data-testid="header-menu-view-board"
            onClick={onViewOnBoard}
            className="cursor-pointer"
          >
            <Columns3 className="icon-base mr-2" />
            {t('kanban.viewOnBoard', 'View on Board')}
          </DropdownMenuItem>
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
      {threadId && (
        <DropdownMenuItem
          data-testid="header-menu-toggle-timeline"
          onClick={toggleTimeline}
          className="cursor-pointer"
        >
          <Milestone className={`icon-base mr-2 ${timelineVisible ? 'text-primary' : ''}`} />
          {t('thread.toggleTimeline', 'Toggle Timeline')}
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid="header-menu-copy-text"
        onClick={() => handleCopy(false)}
        disabled={!hasMessages}
        className="cursor-pointer"
      >
        {copiedText ? <Check className="icon-base mr-2" /> : <Copy className="icon-base mr-2" />}
        {t('thread.copyText', 'Copy text only')}
      </DropdownMenuItem>
      <DropdownMenuItem
        data-testid="header-menu-copy-all"
        onClick={() => handleCopy(true)}
        disabled={!hasMessages}
        className="cursor-pointer"
      >
        {copiedTools ? (
          <Check className="icon-base mr-2" />
        ) : (
          <ClipboardList className="icon-base mr-2" />
        )}
        {t('thread.copyWithTools', 'Copy with tool calls')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <OpenInEditorSubmenu testId="header-menu-open-editor" onPick={handleOpenInEditor} />
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
export const MoreActionsMenu = memo(function MoreActionsMenu({ onViewOnBoard }: Props) {
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
          <MenuItems menu={menu} onViewOnBoard={onViewOnBoard} />
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
