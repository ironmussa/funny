import { BarChart3, Columns3, LayoutGrid, PanelLeftClose, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { OrgSwitcher } from '@/components/OrgSwitcher';
import { Button } from '@/components/ui/button';
import { SidebarHeader, useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { buildPath } from '@/lib/url';

/**
 * Top of AppSidebar: organization switcher + 5 icon-button shortcuts
 * (search/list, kanban, grid, analytics, collapse). Hidden until hover.
 *
 * Extracted from Sidebar.tsx as part of the god-file split.
 */
export function SidebarTopBar() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const { toggleSidebar } = useSidebar();

  return (
    <SidebarHeader className="group/header flex-row items-center justify-between px-2 py-2">
      <div className="min-w-0 flex-1">
        <OrgSwitcher />
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/header:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              data-testid="sidebar-search"
              aria-label={t('sidebar.search', 'Search')}
              onClick={() => navigate(buildPath('/list'))}
              className="text-muted-foreground"
            >
              <Search className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('sidebar.search', 'Search')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              data-testid="sidebar-kanban"
              aria-label="Kanban"
              onClick={() => navigate(buildPath('/kanban'))}
              className="text-muted-foreground"
            >
              <Columns3 className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Kanban</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              data-testid="sidebar-grid"
              aria-label="Grid"
              onClick={() => navigate(buildPath('/grid'))}
              className="text-muted-foreground"
            >
              <LayoutGrid className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Grid</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              data-testid="sidebar-analytics"
              aria-label={t('sidebar.analytics')}
              onClick={() => navigate(buildPath('/analytics'))}
              className="text-muted-foreground"
            >
              <BarChart3 className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('sidebar.analytics')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              data-testid="sidebar-collapse"
              aria-label={t('sidebar.collapse', 'Collapse sidebar')}
              onClick={toggleSidebar}
              className="text-muted-foreground"
            >
              <PanelLeftClose className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('sidebar.collapse', 'Collapse sidebar')}</TooltipContent>
        </Tooltip>
      </div>
    </SidebarHeader>
  );
}
