import { ChevronRight } from 'lucide-react';
import { useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

import { ThreadList } from './ThreadList';

interface Props {
  scrollRef: RefObject<HTMLDivElement | null>;
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
 * scroll-edge fade. Collapsible (matches Quick Chats section behavior).
 */
export function SidebarThreadsSection({
  scrollRef,
  onRenameThread,
  onArchiveThread,
  onDeleteThread,
}: Props) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(true);

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
        <ScrollArea viewportRef={scrollRef} className="relative min-h-0 flex-1 px-2 pb-2">
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
