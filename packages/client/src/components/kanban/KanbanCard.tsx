import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { GitStatusInfo, Thread, ThreadStage } from '@funny/shared';
import { Archive, MoreVertical, Trash2 } from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  memo,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { BOARD_CARD_TITLE_CLASS, BoardCard } from '@/components/board/BoardCard';
import { GitStatsChip } from '@/components/git/GitStatsChip';
import { StopThreadMenuItem } from '@/components/thread/StopThreadMenuItem';
import { ThreadTitle } from '@/components/thread/ThreadAttachmentsBadge';
import { ThreadOpenMenuItems } from '@/components/thread/ThreadOpenMenuItems';
import { ThreadStatusPin } from '@/components/thread/ThreadStatusPin';
import { ThreadWatcherIndicator } from '@/components/thread/ThreadWatcherIndicator';
import { ThreadPowerline } from '@/components/ThreadPowerline';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { HighlightText, normalize } from '@/components/ui/highlight-text';
import { useLeftViewPath } from '@/hooks/use-left-view';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { setDashedDragPreview } from '@/lib/drag-preview';
import { timeAgo } from '@/lib/thread-utils';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

interface Props {
  thread: Thread;
  projectInfo?: { name: string; color?: string; path?: string };
  /** Shows "Delete" in the card's menu. */
  onDelete?: (thread: Thread) => void;
  onArchive?: (thread: Thread) => void;
  search?: string;
  caseSensitive?: boolean;
  ghost?: boolean;
  contentSnippet?: string;
  projectId?: string;
  highlighted?: boolean;
  stage: ThreadStage;
  gitStatus?: GitStatusInfo;
  /** What a board adds under the title (the factory board: the run's chips and notes). */
  children?: ReactNode;
  /** Replaces opening the thread (the factory board opens the run's panel). */
  onOpen?: () => void;
  /** False on a board whose cards only the server moves. */
  draggable?: boolean;
  testId?: string;
  /** Items a board puts first in the card's menu (the factory board: the run's actions). */
  menuItems?: ReactNode;
  /** Items a board puts last in the card's menu (the factory board: the run's threads). */
  menuEndItems?: ReactNode;
  /** Replaces the footer's time (the factory board: the run's time in its step). */
  time?: ReactNode;
  /** Replaces the thread's title (the factory board: the run's issue title). */
  title?: string;
  /** Replaces the thread's status pin (the factory board: the run's state, selectable). */
  status?: ReactNode;
  /** Replaces the footer's powerline (the factory board: links to the run's threads). */
  footerLead?: ReactNode;
  /** What a board adds under the footer line (the factory board: what the run blocks). */
  below?: ReactNode;
}

/** Scrolls a highlighted card into view and makes the card draggable between columns. */
function useKanbanCardDrag(
  ref: RefObject<HTMLDivElement | null>,
  thread: Thread,
  canDrag: boolean,
  highlighted: boolean | undefined,
): boolean {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (highlighted && ref.current) {
      ref.current.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [highlighted, ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !canDrag) return;
    return draggable({
      element: el,
      getInitialData: () => ({
        type: 'kanban-card',
        threadId: thread.id,
        sourceStage: thread.archived ? 'archived' : thread.stage || 'backlog',
        projectId: thread.projectId,
      }),
      onGenerateDragPreview: ({ nativeSetDragImage }) =>
        setDashedDragPreview({ nativeSetDragImage, source: el }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
  }, [ref, thread.id, thread.stage, thread.archived, thread.projectId, canDrag]);

  return isDragging;
}

/** The card's footer: powerline, watcher indicator and the git stats chip (PR, changes, commits). */
function KanbanCardFooter({
  thread,
  projectInfo,
  gitStatus,
  lead,
}: {
  thread: Thread;
  projectInfo: Props['projectInfo'];
  gitStatus: GitStatusInfo | undefined;
  lead?: ReactNode;
}) {
  return (
    <>
      {lead ?? (
        <ThreadPowerline
          thread={thread}
          showPRBadge={false}
          // The git stats chip beside it carries the uncommitted files
          showDiffStats={false}
          projectName={projectInfo?.name}
          projectColor={projectInfo?.color}
          gitStatus={gitStatus}
          diffStatsSize="xxs"
          data-testid={`kanban-card-powerline-${thread.id}`}
        />
      )}
      <ThreadWatcherIndicator threadId={thread.id} />
      {gitStatus && (
        <GitStatsChip
          gitStatus={gitStatus}
          id={thread.id}
          testIdPrefix="kanban-card-git"
          prTestId={`kanban-card-pr-${thread.id}`}
          projectId={thread.projectId || undefined}
        />
      )}
    </>
  );
}

/** The card's three-dot menu. */
function KanbanCardMenu({
  thread,
  menuItems,
  menuEndItems,
  onArchive,
  onDelete,
  onOpenChange,
}: {
  thread: Thread;
  menuItems: ReactNode;
  menuEndItems?: ReactNode;
  onArchive: Props['onArchive'];
  onDelete: Props['onDelete'];
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const isRunning = thread.status === 'running';
  const isBusy = isRunning || thread.status === 'setting_up';
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="muted"
          size="icon-xs"
          tabIndex={-1}
          data-testid={`kanban-card-more-${thread.id}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="icon-sm" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom">
        {menuItems && (
          <>
            {menuItems}
            <DropdownMenuSeparator />
          </>
        )}
        <ThreadOpenMenuItems thread={thread} />
        {isRunning && (
          <>
            <DropdownMenuSeparator />
            <StopThreadMenuItem threadId={thread.id} />
          </>
        )}
        {onArchive && !isBusy && (
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onArchive(thread);
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
              variant="destructive"
              data-testid={`kanban-card-delete-${thread.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(thread);
              }}
            >
              <Trash2 className="icon-sm" />
              {t('common.delete')}
            </DropdownMenuItem>
          </>
        )}
        {menuEndItems && (
          <>
            <DropdownMenuSeparator />
            {menuEndItems}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A message snippet that matched the search, shown when the title did not. */
function KanbanCardSnippet({
  title,
  contentSnippet,
  search,
}: {
  title: string;
  contentSnippet: string | undefined;
  search: string | undefined;
}) {
  if (!contentSnippet || !search || normalize(title).includes(normalize(search))) return null;
  return (
    <HighlightText
      text={contentSnippet}
      query={search}
      className="text-muted-foreground text-compact line-clamp-2 block italic"
    />
  );
}

/**
 * Opens the card's thread. From the board as a left view, the board stays
 * beside the thread (`?left=kanban`), so the thread needs no way back to it:
 * only a search is handed over (to reopen it in the thread).
 */
function useOpenCardThread(
  thread: Props['thread'],
  { projectId, search, caseSensitive }: Pick<Props, 'projectId' | 'search' | 'caseSensitive'>,
) {
  const navigate = useNavigate();
  const besideBoard = useLeftViewPath();
  const setKanbanContext = useUIStore((s) => s.setKanbanContext);
  return () =>
    startTransition(() => {
      setKanbanContext(
        search?.trim() ? { projectId, search, caseSensitive, threadId: thread.id } : null,
      );
      navigate(besideBoard(buildPath(`/projects/${thread.projectId}/threads/${thread.id}`)));
    });
}

export const KanbanCard = memo(function KanbanCard({
  thread,
  projectInfo,
  onDelete,
  onArchive,
  search,
  caseSensitive,
  ghost,
  contentSnippet,
  projectId,
  highlighted,
  stage: _stage,
  gitStatus: gitStatusProp,
  children,
  onOpen,
  draggable: canDrag = true,
  testId,
  menuItems,
  menuEndItems,
  time,
  title: titleProp,
  status,
  footerLead,
  below,
}: Props) {
  const title = titleProp ?? thread.title;
  const { t } = useTranslation();
  const now = useMinuteTick();
  const openThread = useOpenCardThread(thread, { projectId, search, caseSensitive });
  const pinThread = useThreadStore((s) => s.pinThread);
  const ref = useRef<HTMLDivElement>(null);
  const isDragging = useKanbanCardDrag(ref, thread, canDrag, highlighted);

  const [openDropdown, setOpenDropdown] = useState(false);
  const handleDropdownChange = useCallback((open: boolean) => setOpenDropdown(open), []);

  const open = () => {
    if (isDragging) return;
    if (onOpen) return onOpen();
    openThread();
  };

  return (
    <BoardCard
      ref={ref}
      testId={testId ?? `kanban-card-${thread.id}`}
      draggable={canDrag ? undefined : false}
      onOpen={open}
      className={cn(
        isDragging && 'opacity-40',
        ghost && !isDragging && 'opacity-50 hover:opacity-80',
        highlighted && 'ring-2 ring-ring shadow-md',
      )}
      status={
        status ?? (
          <ThreadStatusPin
            thread={thread}
            onPin={(pinned) => pinThread(thread.id, thread.projectId, pinned)}
            hoverGroup="card"
          />
        )
      }
      title={
        <ThreadTitle
          title={title}
          projectId={thread.projectId || undefined}
          search={search || ''}
          multiline
          containerClassName="flex-1"
          className={BOARD_CARD_TITLE_CLASS}
          stopBadgePropagation
          badgeTestId={`kanban-card-attachments-${thread.id}`}
        />
      }
      below={below}
      footer={
        <KanbanCardFooter
          thread={thread}
          projectInfo={projectInfo}
          gitStatus={gitStatusProp}
          lead={footerLead}
        />
      }
      time={time ?? timeAgo(thread.completedAt || thread.createdAt, t, now)}
      actionsOpen={openDropdown}
      actions={
        <KanbanCardMenu
          thread={thread}
          menuItems={menuItems}
          menuEndItems={menuEndItems}
          onArchive={onArchive}
          onDelete={onDelete}
          onOpenChange={handleDropdownChange}
        />
      }
    >
      <KanbanCardSnippet title={title} contentSnippet={contentSnippet} search={search} />
      {children}
    </BoardCard>
  );
});
