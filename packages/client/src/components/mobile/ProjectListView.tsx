import type { Project } from '@funny/shared';
import { Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ScrollArea } from '@/components/ui/scroll-area';

interface Props {
  projects: Project[];
  onSelect: (id: string) => void;
}

export function ProjectListView({ projects, onSelect }: Props) {
  const { t } = useTranslation();
  return (
    <>
      <header className="flex shrink-0 items-center border-b border-border px-4 py-3">
        <h1 className="text-base font-semibold">funny</h1>
      </header>
      <ScrollArea className="flex-1">
        {projects.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
            {t('sidebar.noProjects', 'No projects yet. Add one from the desktop app.')}
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => onSelect(project.id)}
                className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-accent active:bg-accent/80"
              >
                <Folder className="icon-lg shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{project.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{project.path}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </>
  );
}
