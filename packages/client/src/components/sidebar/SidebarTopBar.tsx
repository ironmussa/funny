import { BarChart3, Columns3, Factory, LayoutGrid, PanelLeftClose, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { OrgSwitcher } from '@/components/OrgSwitcher';
import { AutomationInboxButton } from '@/components/sidebar/AutomationInboxButton';
import { Button } from '@/components/ui/button';
import { SidebarHeader, useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAutomationInbox } from '@/data/automations/hooks';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';

/** Shortcuts appear only while the pointer is over the top bar. */
const HOVER_REVEAL = 'shrink-0 opacity-0 transition-opacity group-hover/header:opacity-100';

/**
 * Top of AppSidebar: the collapse button on the left, the organization
 * switcher, then icon-button shortcuts (search/list, automation inbox, factory
 * queue, kanban, grid, analytics). Buttons are hidden until hover; the inbox
 * stays visible while it has pending items.
 *
 * Extracted from Sidebar.tsx as part of the god-file split.
 */
export function SidebarTopBar() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const { toggleSidebar } = useSidebar();
  const { pendingCount } = useAutomationInbox();

  return (
    <SidebarHeader className="group/header flex-row items-center justify-between gap-0.5 px-2 py-2">
      <div className={HOVER_REVEAL}>
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
      <div className="min-w-0 flex-1">
        <OrgSwitcher />
      </div>
      <div className={HOVER_REVEAL}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="muted"
              size="icon-sm"
              tabIndex={-1}
              data-testid="sidebar-search"
              aria-label={t('sidebar.search', 'Search')}
              onClick={() => navigate(buildPath('/list'))}
            >
              <Search className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('sidebar.search', 'Search')}</TooltipContent>
        </Tooltip>
      </div>
      <AutomationInboxButton
        className={cn('shrink-0 transition-opacity', pendingCount === 0 && HOVER_REVEAL)}
      />
      <div className={cn('flex items-center gap-0.5', HOVER_REVEAL)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="muted"
              size="icon-sm"
              tabIndex={-1}
              data-testid="sidebar-factory"
              aria-label={t('sidebar.factory', 'Factory queue')}
              onClick={() => navigate(buildPath('/factory'))}
            >
              <Factory className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('sidebar.factory', 'Factory queue')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="muted"
              size="icon-sm"
              tabIndex={-1}
              data-testid="sidebar-kanban"
              aria-label="Kanban"
              onClick={() => navigate(buildPath('/kanban'))}
            >
              <Columns3 className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Kanban</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="muted"
              size="icon-sm"
              tabIndex={-1}
              data-testid="sidebar-grid"
              aria-label="Grid"
              onClick={() => navigate(buildPath('/grid'))}
            >
              <LayoutGrid className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Grid</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="muted"
              size="icon-sm"
              tabIndex={-1}
              data-testid="sidebar-analytics"
              aria-label={t('sidebar.analytics')}
              onClick={() => navigate(buildPath('/analytics'))}
            >
              <BarChart3 className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('sidebar.analytics')}</TooltipContent>
        </Tooltip>
      </div>
    </SidebarHeader>
  );
}
