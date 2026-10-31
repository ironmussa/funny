import type { Project } from '@funny/shared';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';
import { colorFromName } from '@/components/ui/project-chip';

export function ProjectPickerResults({
  projects,
  onSelect,
}: {
  projects: Project[];
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (projects.length === 0)
    return <EmptyState fill={false} className="py-3" title={t('commandPalette.noResults')} />;
  return projects.map((project) => (
    <button
      key={project.id}
      className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors"
      onClick={() => onSelect(project.id)}
    >
      <span
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: project.color || colorFromName(project.name) }}
      />
      <span className="truncate">{project.name}</span>
    </button>
  ));
}
