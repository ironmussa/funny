import { Keyboard, LogOut, Settings, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AutomationInboxButton } from '@/components/sidebar/AutomationInboxButton';
import { KeyboardShortcutsDialog } from '@/components/sidebar/KeyboardShortcutsDialog';
import { WatcherPanelButton } from '@/components/sidebar/WatcherPanelButton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarFooter as ShadSidebarFooter } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { useUIStore } from '@/stores/ui-store';

/**
 * Bottom of AppSidebar: automation-inbox button, user identity (when signed
 * in), an always-visible settings shortcut, and an account menu (shortcuts +
 * logout) opened by clicking the avatar/name row.
 *
 * Extracted from Sidebar.tsx as part of the god-file split.
 */
export function SidebarFooter() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const authUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const openShortcuts = useUIStore((s) => s.setKeyboardShortcutsOpen);
  const openSettings = () => navigate(buildPath('/preferences/general'));

  return (
    <ShadSidebarFooter className="pb-4">
      <div className="px-1">
        <AutomationInboxButton />
        <WatcherPanelButton />
      </div>
      <div className="flex items-center gap-2 px-1">
        {authUser ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                data-testid="sidebar-user-menu"
                className="hover:bg-sidebar-accent h-auto min-w-0 flex-1 justify-start gap-2 px-1 py-1"
              >
                <Avatar size="sm">
                  <AvatarFallback className="text-xs" name={authUser.displayName || undefined}>
                    {authUser.displayName
                      ?.split(' ')
                      .map((n) => n[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase() || <User className="icon-sm" />}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 text-left">
                  <p className="text-sidebar-foreground truncate text-sm font-medium">
                    {authUser.displayName}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">@{authUser.username}</p>
                </div>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-48">
              <DropdownMenuItem
                data-testid="sidebar-user-shortcuts"
                onClick={() => openShortcuts(true)}
              >
                <Keyboard className="icon-sm" />
                {t('shortcuts.title')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem data-testid="sidebar-logout" onClick={logout}>
                <LogOut className="icon-sm" />
                {t('auth.logout')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              data-testid="sidebar-settings"
              onClick={openSettings}
              className={cn('size-7 shrink-0 text-muted-foreground', !authUser && 'ml-auto')}
            >
              <Settings className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('settings.title')}</TooltipContent>
        </Tooltip>
      </div>
      <KeyboardShortcutsDialog />
    </ShadSidebarFooter>
  );
}
