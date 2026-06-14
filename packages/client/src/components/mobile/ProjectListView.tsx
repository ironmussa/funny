import type { Project } from '@funny/shared';
import { Folder } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface Props {
  projects: Project[];
  onSelect: (id: string) => void;
}

export function ProjectListView({ projects, onSelect }: Props) {
  const { t } = useTranslation();

  // Tap feedback: highlight the tapped row firmly, then navigate so the
  // confirmation is visible even on a quick tap (the list unmounts on nav).
  const [pressedId, setPressedId] = useState<string | null>(null);
  const handleSelect = (id: string) => {
    setPressedId(id);
    setTimeout(() => onSelect(id), 120);
  };
  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <img
          src="/favicon.svg"
          alt=""
          aria-hidden="true"
          className="icon-lg shrink-0"
          data-testid="mobile-project-list-home-icon"
        />
        <h1 className="text-base font-semibold">funny</h1>
      </header>
      <ScrollArea className="flex-1">
        {projects.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center p-4 text-sm">
            {t('sidebar.noProjects', 'No projects yet. Add one from the desktop app.')}
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => handleSelect(project.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-accent',
                  pressedId === project.id ? 'bg-accent' : 'active:bg-accent',
                )}
              >
                <Folder className="icon-lg text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{project.name}</div>
                  <div className="text-muted-foreground truncate text-xs">{project.path}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </>
  );
}
