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
    <div className="px-2 pb-1 pt-2">
      <div className="group/projects mb-1 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('sidebar.addProject')}</TooltipContent>
        </Tooltip>
      </div>
      {projects.length === 0 && (
        <button
          onClick={() => setAddProjectOpen(true)}
          className="w-full cursor-pointer px-2 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('sidebar.noProjects')}
        </button>
      )}
    </div>
  );
}
