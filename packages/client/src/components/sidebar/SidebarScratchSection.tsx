import { Plus } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { useScratchThreads } from '@/lib/thread-selectors';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import type { DeleteThreadConfirmState } from './SidebarDialogs';
import { ThreadItem } from './ThreadItem';

interface SidebarScratchSectionProps {
  onDeleteThread?: (state: DeleteThreadConfirmState) => void;
}

/**
 * Sidebar section for the user's scratch (projectless) threads.
 * Sits between SidebarThreadsSection and SidebarProjectsSection.
 *
 * Hidden when there are no scratch threads AND the user hasn't started
 * composing one — keeps the sidebar uncluttered for users who never use
 * the feature.
 */
export function SidebarScratchSection({ onDeleteThread }: SidebarScratchSectionProps = {}) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const scratchThreads = useScratchThreads();
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const startNewScratchThread = useUIStore((s) => s.startNewScratchThread);

  const handleNewScratch = useCallback(() => {
    startNewScratchThread();
    navigate(buildPath('/scratch/new'));
  }, [startNewScratchThread, navigate]);

  const handleSelect = useCallback(
    (thread: { id: string; projectId: string; isScratch?: boolean }) => {
      useThreadStore.setState({ selectedThreadId: thread.id });
      navigate(buildPath(getThreadRoute(thread)));
    },
    [navigate],
  );

  const handleRequestDelete = useCallback(
    (threadId: string, title: string) => {
      if (!onDeleteThread) return;
      onDeleteThread({ threadId, projectId: '', title, isScratch: true });
    },
    [onDeleteThread],
  );

  // Always render so the "+ New" entry point is discoverable.
  return (
    <div
      className="flex max-h-[30%] min-h-[3rem] shrink-0 flex-col contain-paint"
      data-testid="sidebar-scratch-section"
    >
      <div className="flex items-center justify-between px-4 pb-2 pt-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('sidebar.scratchTitle', { defaultValue: 'Scratch' })}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-foreground"
          onClick={handleNewScratch}
          data-testid="sidebar-scratch-new"
          aria-label={t('sidebar.scratchNew', { defaultValue: 'New scratch thread' })}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <ScrollArea className="relative min-h-0 px-2 pb-2">
        {scratchThreads.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground/60">
            {t('sidebar.scratchEmpty', { defaultValue: 'No scratch threads yet.' })}
          </div>
        ) : (
          scratchThreads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              projectPath=""
              isSelected={selectedThreadId === thread.id}
              onSelect={() => handleSelect(thread)}
              onDelete={
                onDeleteThread ? () => handleRequestDelete(thread.id, thread.title) : undefined
              }
            />
          ))
        )}
      </ScrollArea>
    </div>
  );
}
