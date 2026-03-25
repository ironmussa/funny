import type { Thread } from '@funny/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { BranchBadge } from '@/components/BranchBadge';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { ProjectChip, colorFromName } from '@/components/ui/project-chip';
import { statusConfig } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

interface ThreadPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (threadId: string) => void;
  excludeIds?: string[];
}

export function ThreadPickerDialog({
  open,
  onOpenChange,
  onSelect,
  excludeIds = [],
}: ThreadPickerDialogProps) {
  // Skip store subscriptions and all computation when the dialog is closed.
  // This avoids re-rendering on every threadsByProject update and prevents
  // cmdk from mounting/scoring all items while invisible.
  if (!open) {
    return null;
  }

  return (
    <ThreadPickerDialogContent
      open={open}
      onOpenChange={onOpenChange}
      onSelect={onSelect}
      excludeIds={excludeIds}
    />
  );
}

function ThreadPickerDialogContent({
  open,
  onOpenChange,
  onSelect,
  excludeIds,
}: ThreadPickerDialogProps) {
  const { t } = useTranslation();
  const threadsByProject = useThreadStore((s) => s.threadsByProject);
  const projects = useProjectStore((s) => s.projects);

  const excludeSet = useMemo(() => new Set(excludeIds), [excludeIds]);

  const groupedThreads = useMemo(() => {
    const groups: { project: (typeof projects)[0]; threads: Thread[] }[] = [];

    for (const project of projects) {
      const threads = (threadsByProject[project.id] ?? []).filter(
        (th) => !th.archived && !excludeSet.has(th.id),
      );
      if (threads.length > 0) {
        groups.push({ project, threads });
      }
    }

    return groups;
  }, [projects, threadsByProject, excludeSet]);

  const totalAvailable = groupedThreads.reduce((sum, g) => sum + g.threads.length, 0);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        data-testid="thread-picker-search"
        placeholder={t('live.searchThreads', 'Search threads...')}
      />
      <CommandList>
        <CommandEmpty>
          {totalAvailable === 0
            ? t('live.noThreadsAvailable', 'No threads available')
            : t('commandPalette.noResults', 'No results')}
        </CommandEmpty>
        {groupedThreads.map(({ project, threads }) => (
          <CommandGroup
            key={project.id}
            heading={
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: project.color || colorFromName(project.name) }}
                />
                {project.name}
              </span>
            }
          >
            {threads.map((thread) => {
              const StatusIcon = statusConfig[thread.status]?.icon;
              const statusClass = statusConfig[thread.status]?.className ?? '';
              return (
                <CommandItem
                  key={thread.id}
                  data-testid={`thread-picker-item-${thread.id}`}
                  value={`${project.name} ${thread.title} ${thread.branch ?? ''}`}
                  onSelect={() => {
                    onSelect(thread.id);
                    onOpenChange(false);
                  }}
                >
                  {StatusIcon && <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', statusClass)} />}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{thread.title}</span>
                    <div className="flex items-center gap-1.5">
                      <ProjectChip
                        name={project.name}
                        color={project.color}
                        size="sm"
                        className="flex-shrink-0"
                      />
                      {(thread.branch || thread.baseBranch) && (
                        <BranchBadge
                          branch={(thread.branch || thread.baseBranch)!}
                          size="xs"
                          className="min-w-0"
                        />
                      )}
                    </div>
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
