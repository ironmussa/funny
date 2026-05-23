import { ChevronRight, NotebookPen, Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ThreadItem } from '@/components/sidebar/ThreadItem';
import { ViewAllButton } from '@/components/sidebar/ViewAllButton';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { useScratchThreads } from '@/lib/thread-selectors';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const QUICK_CHATS_VISIBLE = 5;

interface Props {
  onRenameThread: (projectId: string, threadId: string, newTitle: string) => void;
  onDeleteThread: (threadId: string, projectId: string, title: string, isWorktree: boolean) => void;
}

export function SidebarScratchSection({ onRenameThread, onDeleteThread }: Props) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const scratchThreads = useScratchThreads();
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const startNewScratchThread = useUIStore((s) => s.startNewScratchThread);
  const [isExpanded, setIsExpanded] = useState(true);

  const visibleThreads = useMemo(
    () => scratchThreads.slice(0, QUICK_CHATS_VISIBLE),
    [scratchThreads],
  );

  const handleNewScratch = useCallback(() => {
    startNewScratchThread();
    navigate(buildPath('/scratch/new'));
  }, [startNewScratchThread, navigate]);

  const handleOpenList = useCallback(() => {
    navigate(buildPath('/list?scratch=1'));
  }, [navigate]);

  return (
    <div className="shrink-0 px-2 pb-2 pt-2" data-testid="sidebar-scratch-section">
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded} className="min-w-0">
        <div
          className={cn(
            'group/quickchats flex items-center rounded-md select-none',
            'hover:bg-accent/50 text-muted-foreground hover:text-foreground',
          )}
        >
          <CollapsibleTrigger
            data-testid="sidebar-scratch-toggle"
            aria-label={t('sidebar.scratchTitle', { defaultValue: 'Quick Chats' })}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-0 px-2 py-1 text-left text-xs"
          >
            <span className="-ml-0.5 flex-shrink-0 rounded p-0.5">
              <ChevronRight
                className={cn(
                  'icon-sm transition-transform duration-200',
                  isExpanded && 'rotate-90',
                )}
              />
            </span>
            <span className="ml-1.5 flex min-w-0 flex-1 items-center gap-1.5">
              <NotebookPen className="icon-sm flex-shrink-0 text-muted-foreground" />
            </span>
          </CollapsibleTrigger>
          <div className="mr-2 flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  tabIndex={-1}
                  data-testid="sidebar-scratch-new"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNewScratch();
                  }}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={t('sidebar.scratchNew', { defaultValue: 'New quick chat' })}
                >
                  <Plus className="icon-sm" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {t('sidebar.scratchNew', { defaultValue: 'New quick chat' })}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <CollapsibleContent className="data-[state=open]:animate-slide-down">
          <div className="mt-0.5 min-w-0">
            {visibleThreads.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                {t('sidebar.noQuickChats', { defaultValue: 'No quick chats yet' })}
              </p>
            )}
            {visibleThreads.map((thread) => (
              <ScratchThreadRow
                key={thread.id}
                thread={thread}
                isSelected={selectedThreadId === thread.id}
                onRenameThread={onRenameThread}
                onDeleteThread={onDeleteThread}
              />
            ))}
            {scratchThreads.length > QUICK_CHATS_VISIBLE && (
              <ViewAllButton data-testid="sidebar-scratch-view-all" onClick={handleOpenList} />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

interface ScratchThreadRowProps {
  thread: import('@funny/shared').Thread;
  isSelected: boolean;
  onRenameThread: Props['onRenameThread'];
  onDeleteThread: Props['onDeleteThread'];
}

function ScratchThreadRow({
  thread,
  isSelected,
  onRenameThread,
  onDeleteThread,
}: ScratchThreadRowProps) {
  const navigate = useStableNavigate();

  const handleSelect = useCallback(() => {
    navigate(buildPath(getThreadRoute(thread)));
  }, [navigate, thread]);

  const handleRename = useCallback(
    (newTitle: string) => onRenameThread('', thread.id, newTitle),
    [onRenameThread, thread.id],
  );

  const handleDelete = useCallback(
    () => onDeleteThread(thread.id, '', thread.title, false),
    [onDeleteThread, thread.id, thread.title],
  );

  return (
    <ThreadItem
      thread={thread}
      projectPath=""
      isSelected={isSelected}
      onSelect={handleSelect}
      href={buildPath(getThreadRoute(thread))}
      onRename={handleRename}
      onDelete={handleDelete}
    />
  );
}
