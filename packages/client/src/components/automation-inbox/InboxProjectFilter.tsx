import type { Project } from '@funny/shared';
import { Check, ChevronsUpDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
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

interface InboxProjectFilterProps {
  projectsWithItems: Project[];
  filterProjectId: string | null;
  setFilterProjectId: (projectId: string | null) => void;
  filterOpen: boolean;
  setFilterOpen: (open: boolean) => void;
  filterListId: string;
}

export function InboxProjectFilter({
  projectsWithItems,
  filterProjectId,
  setFilterProjectId,
  filterOpen,
  setFilterOpen,
  filterListId,
}: InboxProjectFilterProps) {
  return (
    <div className="border-border flex items-center gap-2 border-b px-6 py-2">
      <Popover open={filterOpen} onOpenChange={setFilterOpen}>
        <PopoverTrigger asChild>
          <Button
            size="xs"
            variant="outline"
            role="combobox"
            aria-expanded={filterOpen}
            aria-controls={filterListId}
            data-testid="inbox-project-filter"
            weight="normal"
            className="w-[200px] justify-between"
          >
            {filterProjectId
              ? projectsWithItems.find((p) => p.id === filterProjectId)?.name
              : 'All projects'}
            <ChevronsUpDown className="icon-xs ml-2 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent padding="none" className="w-[200px]" align="start">
          <Command>
            <CommandInput placeholder="Search project..." textSize="xs" className="h-8" />
            <CommandList id={filterListId}>
              <CommandEmpty textSize="xs">No project found.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="all"
                  onSelect={() => {
                    setFilterProjectId(null);
                    setFilterOpen(false);
                  }}
                  textSize="xs"
                >
                  <Check
                    className={cn('mr-2 icon-xs', !filterProjectId ? 'opacity-100' : 'opacity-0')}
                  />
                  All projects
                </CommandItem>
                {projectsWithItems.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={p.name}
                    onSelect={() => {
                      setFilterProjectId(p.id);
                      setFilterOpen(false);
                    }}
                    textSize="xs"
                  >
                    <Check
                      className={cn(
                        'mr-2 icon-xs',
                        filterProjectId === p.id ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    {p.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
