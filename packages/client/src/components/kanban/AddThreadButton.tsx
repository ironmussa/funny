import type { Project } from '@funny/shared';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { colorFromName } from '@/components/ui/project-chip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  projectId?: string;
  projects: Project[];
  onSelect: (projectId: string) => void;
}

/**
 * "+" button at the top of a kanban column. In single-project mode it goes
 * straight to a new thread; otherwise it opens a Popover with a project
 * search list so the user picks the target project first.
 */
export function AddThreadButton({ projectId, projects, onSelect }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  if (projectId) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-testid="kanban-add-thread"
            className="ml-auto rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => onSelect(projectId)}
            aria-label={t('kanban.addThread')}
          >
            <Plus className="icon-base" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('kanban.addThread')}</TooltipContent>
      </Tooltip>
    );
  }

  const filtered = search
    ? projects.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : projects;

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSearch('');
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              data-testid="kanban-add-thread"
              className="ml-auto rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={t('kanban.addThread')}
            >
              <Plus className="icon-base" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('kanban.addThread')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="border-b border-border/50 px-2 py-1.5">
          <SearchBar
            inputRef={inputRef}
            query={search}
            onQueryChange={setSearch}
            placeholder={t('kanban.searchProject')}
            totalMatches={filtered.length}
            resultLabel={search ? `${filtered.length}/${projects.length}` : ''}
            autoFocus
            testIdPrefix="kanban-add-thread-search"
          />
        </div>
        <ScrollArea className="max-h-56 py-1">
          {filtered.length === 0 ? (
            <div className="py-3 text-center text-sm text-muted-foreground">
              {t('commandPalette.noResults')}
            </div>
          ) : (
            filtered.map((p) => (
              <button
                key={p.id}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                onClick={() => {
                  setOpen(false);
                  setSearch('');
                  onSelect(p.id);
                }}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: p.color || colorFromName(p.name) }}
                />
                <span className="truncate">{p.name}</span>
              </button>
            ))
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
