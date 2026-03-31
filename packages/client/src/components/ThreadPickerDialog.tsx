import type { Thread } from '@funny/shared';
import { FolderOpen, GitBranch } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { HighlightText } from '@/components/ui/highlight-text';
import { PowerlineBar, type PowerlineSegmentData } from '@/components/ui/powerline-bar';
import { colorFromName, darkenHex } from '@/components/ui/project-chip';
import { statusConfig } from '@/lib/thread-utils';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

/** Return the most recent activity timestamp for a thread (completedAt > createdAt). */
function threadActivityTime(thread: Thread): number {
  return new Date(thread.completedAt ?? thread.createdAt).getTime();
}

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
  const [search, setSearch] = useState('');

  const excludeSet = useMemo(() => new Set(excludeIds), [excludeIds]);

  const groupedThreads = useMemo(() => {
    const groups: { project: (typeof projects)[0]; threads: Thread[] }[] = [];

    for (const project of projects) {
      const threads = (threadsByProject[project.id] ?? [])
        .filter((th) => !th.archived && !excludeSet.has(th.id))
        .sort((a, b) => threadActivityTime(b) - threadActivityTime(a));
      if (threads.length > 0) {
        groups.push({ project, threads });
      }
    }

    // Sort groups so the project with the most recently active thread comes first
    groups.sort((a, b) => threadActivityTime(b.threads[0]) - threadActivityTime(a.threads[0]));

    return groups;
  }, [projects, threadsByProject, excludeSet]);

  const totalAvailable = groupedThreads.reduce((sum, g) => sum + g.threads.length, 0);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        data-testid="thread-picker-search"
        placeholder={t('live.searchThreads', 'Search threads...')}
        onValueChange={setSearch}
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
                  value={`${project.name} ${thread.title} ${resolveThreadBranch(thread) ?? ''}`}
                  onSelect={() => {
                    onSelect(thread.id);
                    onOpenChange(false);
                  }}
                >
                  {StatusIcon && <StatusIcon className={cn('icon-sm shrink-0', statusClass)} />}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <HighlightText
                      text={thread.title}
                      query={search}
                      className="truncate text-sm"
                    />
                    <PowerlineBar
                      size="sm"
                      segments={(() => {
                        const baseColor = project.color || colorFromName(project.name);
                        const segs: PowerlineSegmentData[] = [
                          {
                            key: 'project',
                            icon: FolderOpen,
                            label: project.name,
                            color: baseColor,
                          },
                        ];
                        if (resolveThreadBranch(thread) || thread.baseBranch) {
                          segs.push({
                            key: 'branch',
                            icon: GitBranch,
                            label: (resolveThreadBranch(thread) || thread.baseBranch)!,
                            color: darkenHex(baseColor, 0.12),
                          });
                        }
                        return segs;
                      })()}
                    />
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
