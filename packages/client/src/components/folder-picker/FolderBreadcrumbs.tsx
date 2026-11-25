import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface FolderBreadcrumbsProps {
  breadcrumbs: Array<{ label: string; path: string }>;
  onNavigate: (path: string) => void;
}

/** The clickable path of the folder picker's current directory. */
export function FolderBreadcrumbs({ breadcrumbs, onNavigate }: FolderBreadcrumbsProps) {
  const { t } = useTranslation();
  return (
    <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
      {breadcrumbs.length === 0 && (
        <span className="text-muted-foreground text-xs">{t('folderPicker.loading')}</span>
      )}
      {breadcrumbs.map((crumb, i) => (
        <div key={crumb.path} className="flex shrink-0 items-center gap-0.5">
          {i > 0 && <ChevronRight className="icon-xs text-muted-foreground/50 shrink-0" />}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onNavigate(crumb.path)}
                className={`hover:bg-accent hover:text-foreground max-w-[120px] truncate rounded px-1 py-0.5 text-xs transition-colors ${
                  i === breadcrumbs.length - 1
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground'
                }`}
              >
                {crumb.label}
              </button>
            </TooltipTrigger>
            <TooltipContent variant="mono">{crumb.path}</TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}
