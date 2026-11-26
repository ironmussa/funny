import { PanelLeftClose, Search } from 'lucide-react';
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
 * switcher, then icon-button shortcuts (search/list, automation inbox). The
 * kanban board, the factory queue, the grid and analytics open from the tool
 * rail. Buttons are hidden until hover; the inbox
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
    <SidebarHeader className="group/header">
      <div className="flex items-center justify-between gap-0.5">
        <div className={HOVER_REVEAL}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="muted"
                size="icon-sm"
                tabIndex={-1}
                data-testid="sidebar-collapse"
                aria-label={t('sidebar.collapse', 'Collapse sidebar')}
                onClick={toggleSidebar}
              >
                <PanelLeftClose className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('sidebar.collapse', 'Collapse sidebar')}
            </TooltipContent>
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
        <div className={cn('flex shrink-0 transition-opacity', pendingCount === 0 && HOVER_REVEAL)}>
          <AutomationInboxButton />
        </div>
      </div>
    </SidebarHeader>
  );
}
