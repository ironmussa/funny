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
      <header className="border-border flex shrink-0 items-center border-b px-4 py-3">
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
                onClick={() => onSelect(project.id)}
                className="hover:bg-accent active:bg-accent/80 flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors"
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
