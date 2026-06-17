import { useTranslation } from 'react-i18next';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useThreadsForProject } from '@/lib/thread-selectors';
import { statusConfig } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Project whose threads are offered. */
  projectId: string;
  /** Called with the chosen thread id. */
  onSelect: (threadId: string) => void;
  /** Thread ids already placed in the grid — rendered with an "in grid" hint. */
  gridThreadIds?: Set<string>;
}

/**
 * Modal thread picker for an empty grid cell. Lists the threads of a single
 * project so the user can load an existing thread into the cell instead of
 * creating a new one. Mirrors {@link ProjectPickerDialog}'s CommandDialog shape.
 */
export function ThreadPickerDialog({
  open,
  onOpenChange,
  projectId,
  onSelect,
  gridThreadIds,
}: Props) {
  const { t } = useTranslation();
  const threads = useThreadsForProject(projectId);

  const commit = (threadId: string) => {
    onSelect(threadId);
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        data-testid="grid-thread-picker-search"
        placeholder={t('live.searchThread', 'Search thread...')}
      />
      <CommandList>
        <CommandEmpty>{t('live.noThreads', 'No threads')}</CommandEmpty>
        <CommandGroup heading={t('live.pickThreadTitle', 'Load an existing thread')}>
          {threads.map((thread) => {
            const { icon: Icon, className } = statusConfig[thread.status] ?? statusConfig.idle;
            const inGrid = gridThreadIds?.has(thread.id);
            return (
              <CommandItem
                key={thread.id}
                data-testid={`grid-thread-pick-${thread.id}`}
                value={`${thread.title} ${thread.id}`}
                onSelect={() => commit(thread.id)}
              >
                <Icon className={cn('size-3.5 shrink-0', className)} />
                <span className="truncate">{thread.title || t('common.untitled', 'Untitled')}</span>
                {inGrid && (
                  <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">
                    {t('live.inGrid', 'in grid')}
                  </span>
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
