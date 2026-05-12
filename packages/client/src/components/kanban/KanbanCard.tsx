import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { GitStatusInfo, Thread, ThreadStage } from '@funny/shared';
import {
  Archive,
  FolderOpenDot,
  MoreVertical,
  Pin,
  PinOff,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react';
import { memo, startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

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
import { api } from '@/lib/api';
import { statusConfig, timeAgo } from '@/lib/thread-utils';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

interface Props {
  thread: Thread;
  projectInfo?: { name: string; color?: string; path?: string };
  onDelete: (thread: Thread) => void;
  onArchive?: (thread: Thread) => void;
  search?: string;
  ghost?: boolean;
  contentSnippet?: string;
  projectId?: string;
  highlighted?: boolean;
  stage: ThreadStage;
  gitStatus?: GitStatusInfo;
}

export const KanbanCard = memo(function KanbanCard({
  thread,
  projectInfo,
  onDelete,
  onArchive,
  search,
  ghost,
  contentSnippet,
  projectId,
  highlighted,
  stage: _stage,
  gitStatus: gitStatusProp,
}: Props) {
  const { t } = useTranslation();
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
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: () => ({
        type: 'kanban-card',
        threadId: thread.id,
        sourceStage: thread.archived ? 'archived' : thread.stage || 'backlog',
        projectId: thread.projectId,
      }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
  }, [thread.id, thread.stage, thread.archived, thread.projectId]);

  const StatusIcon = statusConfig[thread.status].icon;
  const statusClassName = statusConfig[thread.status].className;
  const isRunning = thread.status === 'running';
  const isBusy = isRunning || thread.status === 'setting_up';

  const [openDropdown, setOpenDropdown] = useState(false);
  const handleDropdownChange = useCallback((open: boolean) => setOpenDropdown(open), []);

  return (
    <div
      ref={ref}
      data-testid={`kanban-card-${thread.id}`}
      className={cn(
        'group/card flex items-stretch rounded-md border bg-card cursor-pointer transition-[opacity,box-shadow] duration-300',
        isDragging && 'opacity-40',
        ghost && !isDragging && 'opacity-50 hover:opacity-80',
        highlighted && 'ring-2 ring-ring shadow-md',
      )}
      onClick={() => {
        if (!isDragging) {
          startTransition(() => {
            setKanbanContext({ projectId, search, threadId: thread.id, viewMode: 'board' });
            navigate(buildPath(`/projects/${thread.projectId}/threads/${thread.id}`));
          });
        }
      }}
    >
      <div className="min-w-0 flex-1 px-3.5 py-3">
        <div className="mb-2 flex min-w-0 items-start gap-2">
          <div className="relative mt-0.5 size-3.5 shrink-0">
            {thread.pinned && !isBusy ? (
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center text-muted-foreground',
                  'group-hover/card:hidden',
                )}
              >
                <Pin className="icon-sm" />
              </span>
            ) : (
              <span className={cn('absolute inset-0', 'group-hover/card:hidden')}>
                <StatusIcon className={cn('icon-sm', statusClassName)} />
              </span>
            )}
            <span
              className="absolute inset-0 hidden cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground group-hover/card:flex"
              onClick={(e) => {
                e.stopPropagation();
                pinThread(thread.id, thread.projectId, !thread.pinned);
              }}
            >
              {thread.pinned ? <PinOff className="icon-sm" /> : <Pin className="icon-sm" />}
            </span>
          </div>
          <HighlightText
            text={thread.title}
            query={search || ''}
            className="line-clamp-6 text-sm font-medium leading-relaxed text-muted-foreground transition-colors group-hover/card:text-foreground"
          />
        </div>

        <ThreadPowerline
          thread={thread}
          projectName={projectInfo?.name}
          projectColor={projectInfo?.color}
          gitStatus={gitStatusProp}
          diffStatsSize="xxs"
          className="mb-2"
          data-testid={`kanban-card-powerline-${thread.id}`}
        />

        {contentSnippet && search && !normalize(thread.title).includes(normalize(search)) && (
          <HighlightText
            text={contentSnippet}
            query={search}
            className="mb-1 line-clamp-2 block text-[11px] italic text-muted-foreground"
          />
        )}
      </div>

      <div className="flex shrink-0 items-center px-1.5">
        <div className="grid min-w-[2.5rem] place-items-center justify-items-center">
          <span
            className={cn(
              'col-start-1 row-start-1 text-xs text-muted-foreground leading-4 h-4 group-hover/card:opacity-0 group-hover/card:pointer-events-none',
              openDropdown && 'opacity-0 pointer-events-none',
            )}
          >
            {timeAgo(thread.completedAt || thread.createdAt, t)}
          </span>
          <div
            className={cn(
              'col-start-1 row-start-1 flex items-center opacity-0 group-hover/card:opacity-100',
              openDropdown && '!opacity-100',
            )}
          >
            <DropdownMenu onOpenChange={handleDropdownChange}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  tabIndex={-1}
                  data-testid={`kanban-card-more-${thread.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <MoreVertical className="icon-sm" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="bottom">
                <DropdownMenuItem
                  onClick={async (e) => {
                    e.stopPropagation();
                    const folderPath = thread.worktreePath || projectInfo?.path;
                    if (!folderPath) return;
                    const result = await api.openDirectory(folderPath);
                    if (result.isErr()) toastError(result.error);
                  }}
                >
                  <FolderOpenDot className="icon-sm" />
                  {t('sidebar.openDirectory')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={async (e) => {
                    e.stopPropagation();
                    const folderPath = thread.worktreePath || projectInfo?.path;
                    if (!folderPath) return;
                    const result = await api.openTerminal(folderPath);
                    if (result.isErr()) toastError(result.error);
                  }}
                >
                  <Terminal className="icon-sm" />
                  {t('sidebar.openTerminal')}
                </DropdownMenuItem>
                {isRunning && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={async (e) => {
                        e.stopPropagation();
                        const result = await api.stopThread(thread.id);
                        if (result.isErr()) console.error('Failed to stop thread:', result.error);
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
                      onArchive(thread);
                    }}
                  >
                    <Archive className="icon-sm" />
                    {t('sidebar.archive')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-testid={`kanban-card-delete-${thread.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(thread);
                  }}
                  className="text-status-error focus:text-status-error"
                >
                  <Trash2 className="icon-sm" />
                  {t('common.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
});
