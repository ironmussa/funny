import { ChevronRight, Users } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ThreadItem } from '@/components/sidebar/ThreadItem';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useActiveThreadId } from '@/hooks/use-active-thread-id';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { useSharedThreads } from '@/lib/thread-selectors';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';

/**
 * Sidebar bucket for threads other users have shared WITH the current user.
 * Read-only (no rename/delete — the viewer doesn't own them). Hidden entirely
 * when there's nothing shared, so it never adds empty chrome. Populated by
 * `loadSharedThreads()` on boot and refreshed live via the
 * `thread:share-granted` / `thread:share-revoked` WS events.
 */
export function SidebarSharedSection() {
  const { t } = useTranslation();
  const sharedThreads = useSharedThreads();
  // Highlight follows the URL (route-driven), not the async selectedThreadId.
  const activeThreadId = useActiveThreadId();
  const [isExpanded, setIsExpanded] = useState(true);

  if (sharedThreads.length === 0) return null;

  return (
    <div className="shrink-0 px-2 pt-2 pb-2" data-testid="sidebar-shared-section">
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded} className="min-w-0">
        <div
          className={cn(
            'group/shared flex items-center rounded-md select-none',
            'hover:bg-accent/50 text-muted-foreground hover:text-foreground',
          )}
        >
          <CollapsibleTrigger
            data-testid="sidebar-shared-toggle"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-0 px-2 py-1 text-left text-xs"
          >
            <span className="-ml-0.5 shrink-0 rounded p-0.5">
              <ChevronRight
                className={cn(
                  'icon-sm transition-transform duration-200',
                  isExpanded && 'rotate-90',
                )}
              />
            </span>
            <span className="ml-1.5 flex min-w-0 flex-1 items-center gap-1.5">
              <Users className="icon-sm text-muted-foreground shrink-0" />
              <span className="truncate text-sm font-medium">
                {t('sidebar.sharedTitle', { defaultValue: 'Shared with me' })}
              </span>
            </span>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent className="data-[state=open]:animate-slide-down">
          <div className="mt-0.5 min-w-0">
            {sharedThreads.map((thread) => (
              <SharedThreadRow
                key={thread.id}
                thread={thread}
                isSelected={activeThreadId === thread.id}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function SharedThreadRow({
  thread,
  isSelected,
}: {
  thread: import('@funny/shared').Thread;
  isSelected: boolean;
}) {
  const navigate = useStableNavigate();
  const href = buildPath(getThreadRoute(thread));

  const handleSelect = useCallback(() => {
    navigate(href);
  }, [navigate, href]);

  return (
    <ThreadItem
      thread={thread}
      projectPath=""
      isSelected={isSelected}
      onSelect={handleSelect}
      href={href}
    />
  );
}
