import { ChevronRight } from 'lucide-react';
import { useEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

import { ThreadList } from './ThreadList';

interface Props {
  scrollRef: RefObject<HTMLDivElement | null>;
  topSentinelRef: RefObject<HTMLDivElement | null>;
  onRenameThread: (projectId: string, threadId: string, newTitle: string) => void;
  onArchiveThread: (
    threadId: string,
    projectId: string,
    title: string,
    isWorktree: boolean,
  ) => void;
  onDeleteThread: (threadId: string, projectId: string, title: string, isWorktree: boolean) => void;
}

/**
 * The "Activity" pane at the top of AppSidebar — own scroll area with a sticky
 * top fade gradient that reflects scroll state via an IntersectionObserver
 * sentinel. Collapsible (matches Quick Chats section behavior).
 */
export function SidebarThreadsSection({
  scrollRef,
  topSentinelRef,
  onRenameThread,
  onArchiveThread,
  onDeleteThread,
}: Props) {
  const { t } = useTranslation();
  const [scrolled, setScrolled] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    if (!isExpanded) return;
    const root = scrollRef.current;
    const sentinel = topSentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      () => {
        setScrolled(root.scrollTop > 0);
      },
      { root, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scrollRef, topSentinelRef, isExpanded]);

  return (
    <Collapsible
      open={isExpanded}
      onOpenChange={setIsExpanded}
      className={cn('flex shrink-0 flex-col contain-paint', isExpanded && 'max-h-[40%] min-h-20')}
    >
      <CollapsibleTrigger
        data-testid="sidebar-activity-toggle"
        className={cn(
          'group/activity mx-2 flex items-center gap-1 rounded-md px-2 pb-2 pt-3 text-left cursor-pointer select-none',
          'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        )}
      >
        <ChevronRight
          className={cn('icon-sm transition-transform duration-200', isExpanded && 'rotate-90')}
        />
        <h2 className="text-xs font-semibold tracking-wider uppercase">
          {t('sidebar.threadsTitle')}
        </h2>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-slide-down flex min-h-0 flex-1 flex-col">
        <ScrollArea
          viewportRef={scrollRef}
          viewportProps={{
            onScroll: (e) => setScrolled((e.currentTarget as HTMLDivElement).scrollTop > 0),
          }}
          className="relative min-h-0 flex-1 px-2 pb-2"
        >
          <div ref={topSentinelRef} aria-hidden className="h-px shrink-0" />
          <div
            className={cn(
              'sticky top-0 left-0 right-0 h-8 -mt-px -mb-8 bg-linear-to-b from-sidebar to-transparent pointer-events-none z-10',
              scrolled ? 'opacity-100' : 'opacity-0',
            )}
          />
          <ThreadList
            onRenameThread={onRenameThread}
            onArchiveThread={onArchiveThread}
            onDeleteThread={onDeleteThread}
          />
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  );
}
