import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { GitStatusInfo, Thread, ThreadStage } from '@funny/shared';
import { Archive, FolderOpenDot, MoreVertical, Terminal, Trash2 } from 'lucide-react';
import {
  type ReactNode,
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
import { PRBadge } from '@/components/PRBadge';
import { StopThreadMenuItem } from '@/components/thread/StopThreadMenuItem';
import { ThreadTitle } from '@/components/thread/ThreadAttachmentsBadge';
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
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { api } from '@/lib/api';
import { setDashedDragPreview } from '@/lib/drag-preview';
import { openThreadTerminal } from '@/lib/open-terminal-tab';
import { timeAgo } from '@/lib/thread-utils';
import { toastError } from '@/lib/toast-error';
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
  /** Replaces the footer's time (the factory board: the run's time in its step). */
  time?: ReactNode;
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
  time,
}: Props) {
  const { t } = useTranslation();
  const now = useMinuteTick();
  const navigate = useNavigate();
  const setKanbanContext = useUIStore((s) => s.setKanbanContext);
  const pinThread = useThreadStore((s) => s.pinThread);
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (highlighted && ref.current) {
      ref.current.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [highlighted]);

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
  }, [thread.id, thread.stage, thread.archived, thread.projectId, canDrag]);

  const isRunning = thread.status === 'running';
  const isBusy = isRunning || thread.status === 'setting_up';

  const [openDropdown, setOpenDropdown] = useState(false);
  const handleDropdownChange = useCallback((open: boolean) => setOpenDropdown(open), []);

  const open = () => {
    if (isDragging) return;
    if (onOpen) return onOpen();
    startTransition(() => {
      setKanbanContext({
        projectId,
        search,
        caseSensitive,
        threadId: thread.id,
        viewMode: 'board',
      });
      navigate(buildPath(`/projects/${thread.projectId}/threads/${thread.id}`));
    });
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
        <ThreadStatusPin
          thread={thread}
          onPin={(pinned) => pinThread(thread.id, thread.projectId, pinned)}
          hoverGroup="card"
        />
      }
      title={
        <ThreadTitle
          title={thread.title}
          search={search || ''}
          multiline
          containerClassName="flex-1"
          className={BOARD_CARD_TITLE_CLASS}
          stopBadgePropagation
          badgeTestId={`kanban-card-attachments-${thread.id}`}
        />
      }
      footer={
        <>
          <ThreadPowerline
            thread={thread}
            showPRBadge={false}
            projectName={projectInfo?.name}
            projectColor={projectInfo?.color}
            gitStatus={gitStatusProp}
            diffStatsSize="xxs"
            data-testid={`kanban-card-powerline-${thread.id}`}
          />
          <ThreadWatcherIndicator threadId={thread.id} />
          {gitStatusProp?.prNumber ? (
            <PRBadge
              prNumber={gitStatusProp.prNumber}
              prState={gitStatusProp.prState ?? 'OPEN'}
              prUrl={gitStatusProp.prUrl}
              variant="plain"
              size="compact"
              showExternalIcon={false}
              data-testid={`kanban-card-pr-${thread.id}`}
            />
          ) : null}
        </>
      }
      time={time ?? timeAgo(thread.completedAt || thread.createdAt, t, now)}
      actionsOpen={openDropdown}
      actions={
        <DropdownMenu onOpenChange={handleDropdownChange}>
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
            <DropdownMenuItem
              onClick={async (e) => {
                e.stopPropagation();
                const result = await api.openDirectory({ threadId: thread.id });
                if (result.isErr()) toastError(result.error);
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
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {contentSnippet && search && !normalize(thread.title).includes(normalize(search)) && (
        <HighlightText
          text={contentSnippet}
          query={search}
          className="text-muted-foreground text-compact line-clamp-2 block italic"
        />
      )}
      {children}
    </BoardCard>
  );
});
