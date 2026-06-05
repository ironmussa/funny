import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAppStore } from '@/stores/app-store';

export function AddProjectForm() {
  const { t } = useTranslation();
  const setAddProjectOpen = useAppStore((s) => s.setAddProjectOpen);
  const projects = useAppStore((s) => s.projects);

  return (
    <div className="px-2 pt-2 pb-1">
      <div className="group/projects mb-1 flex items-center justify-between">
        <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {t('sidebar.projects')}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setAddProjectOpen(true)}
              className="text-muted-foreground"
            >
              <Plus className="icon-sm" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('sidebar.addProject')}</TooltipContent>
        </Tooltip>
      </div>
      {projects.length === 0 && (
        <button
          onClick={() => setAddProjectOpen(true)}
          className="text-muted-foreground hover:text-foreground w-full cursor-pointer px-2 py-2 text-left text-xs transition-colors"
        >
          {t('sidebar.noProjects')}
        </button>
      )}
    </div>
  );
}
