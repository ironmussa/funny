import type { Project } from '@funny/shared';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  projectFilter: string | null;
  filteredProjectName?: string;
  onChange: (projectId: string | null) => void;
}

/**
 * "Filter by project" chip + Command palette popover for AllThreadsView.
 * Extracted so the parent doesn't import the Command cluster directly (or
 * the Popover/ChevronDown/Check duplicates).
 */
export function ProjectFilterPopover({
  open,
  onOpenChange,
  projects,
  projectFilter,
  filteredProjectName,
  onChange,
}: Props) {
  const { t } = useTranslation();

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          data-testid="all-threads-project-filter"
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap',
            projectFilter
              ? 'bg-accent text-accent-foreground border-accent-foreground/20'
              : 'bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground',
          )}
        >
          {projectFilter && filteredProjectName
            ? filteredProjectName
            : t('allThreads.filterProject')}
          <ChevronDown className="icon-xs opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-0">
        <Command>
          <CommandInput
            placeholder={t('kanban.searchProject')}
            className="h-9 text-xs"
            data-testid="all-threads-project-filter-search"
          />
          <CommandList>
            <CommandEmpty>{t('commandPalette.noResults')}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={t('allThreads.allProjects')}
                onSelect={() => {
                  onChange(null);
                  onOpenChange(false);
                }}
                className="text-xs"
              >
                <span
                  className={cn(
                    'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                    !projectFilter
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-muted-foreground/30',
                  )}
                >
                  {!projectFilter && <Check className="icon-2xs" />}
                </span>
                <span className="flex-1">{t('allThreads.allProjects')}</span>
              </CommandItem>
              {projects.map((p) => {
                const isActive = projectFilter === p.id;
                return (
                  <CommandItem
                    key={p.id}
                    value={`${p.name} ${p.path ?? ''}`}
                    onSelect={() => {
                      onChange(p.id);
                      onOpenChange(false);
                    }}
                    className="text-xs"
                  >
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                        isActive
                          ? 'bg-primary border-primary text-primary-foreground'
                          : 'border-muted-foreground/30',
                      )}
                    >
                      {isActive && <Check className="icon-2xs" />}
                    </span>
                    <span className="flex-1 truncate">{p.name}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
