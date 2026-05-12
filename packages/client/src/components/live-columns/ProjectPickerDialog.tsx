import { useTranslation } from 'react-i18next';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { colorFromName } from '@/components/ui/project-chip';
import { useProjectStore } from '@/stores/project-store';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (projectId: string) => void;
  placeholder?: string;
  title?: string;
}

/**
 * Modal project picker for the grid (Live) view. Shared by the header "+"
 * button, the per-cell "New thread" button, and the Ctrl+N shortcut so the
 * user always sees the same dialog.
 */
export function ProjectPickerDialog({ open, onOpenChange, onSelect, placeholder, title }: Props) {
  const { t } = useTranslation();
  const projects = useProjectStore((s) => s.projects);

  const commit = (projectId: string) => {
    onSelect(projectId);
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        data-testid="grid-project-picker-search"
        placeholder={placeholder ?? t('kanban.searchProject', 'Search project...')}
      />
      <CommandList>
        <CommandEmpty>{t('live.noProjects', 'No projects')}</CommandEmpty>
        <CommandGroup heading={title ?? t('live.pickProjectTitle', 'Select a project')}>
          {projects.map((p) => (
            <CommandItem
              key={p.id}
              data-testid={`grid-project-pick-${p.id}`}
              value={`${p.name} ${p.path ?? ''}`}
              onSelect={() => commit(p.id)}
            >
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: p.color || colorFromName(p.name) }}
              />
              <span className="truncate">{p.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
