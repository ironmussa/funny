import type { Project } from '@funny/shared';
import { ChevronLeft, Columns3, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';

interface AllThreadsHeaderProps {
  projectFilter: string | null;
  filteredProject: Project | null | undefined;
  viewMode: 'list' | 'board';
  scratchOnlyFilter: boolean;
  threadCount: number;
  projectCount: number;
  onBack: () => void;
}

export function AllThreadsHeader({
  projectFilter,
  filteredProject,
  viewMode,
  scratchOnlyFilter,
  threadCount,
  projectCount,
  onBack,
}: AllThreadsHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className="border-border flex items-center gap-3 border-b px-4 py-3">
      {projectFilter && (
        <TooltipIconButton
          variant="muted"
          data-testid="all-threads-back"
          onClick={onBack}

          tooltip={t('common.back')}
        >
          <ChevronLeft className="icon-base" />
        </TooltipIconButton>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          {viewMode === 'board' ? (
            <Columns3 className="icon-sm text-muted-foreground" />
          ) : (
            <Search className="icon-sm text-muted-foreground" />
          )}
          {scratchOnlyFilter
            ? t('sidebar.scratchTitle', { defaultValue: 'Quick Chats' })
            : projectFilter && filteredProject
              ? t('allThreads.title')
              : t('allThreads.globalTitle')}
        </h2>
        <p className="text-muted-foreground text-sm">
          {scratchOnlyFilter
            ? `${threadCount} ${t('allThreads.threads')}`
            : projectFilter && filteredProject
              ? `${filteredProject.name} · ${threadCount} ${t('allThreads.threads')}`
              : `${projectCount} ${t('allThreads.projects')} · ${threadCount} ${t('allThreads.threads')}`}
        </p>
      </div>
    </div>
  );
}
