import { LogOut, MoreVertical, Settings, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AutomationInboxButton } from '@/components/sidebar/AutomationInboxButton';
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
import { useAuthStore } from '@/stores/auth-store';

/**
 * Bottom of AppSidebar: automation-inbox button + (when signed in) avatar
 * with user-menu dropdown for settings/logout, or a settings shortcut when
 * signed out.
 *
 * Extracted from Sidebar.tsx as part of the god-file split.
 */
export function SidebarFooter() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const authUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return (
    <ShadSidebarFooter className="pb-4">
      <div className="px-1">
        <AutomationInboxButton />
      </div>
      <div className="flex items-center gap-2 px-1">
        {authUser ? (
          <>
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
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-sidebar-foreground">
                {authUser.displayName}
              </p>
              <p className="truncate text-xs text-muted-foreground">@{authUser.username}</p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  data-testid="sidebar-user-menu"
                  className="size-7 shrink-0 text-muted-foreground"
                >
                  <MoreVertical className="icon-base" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" className="w-48">
                <DropdownMenuItem
                  data-testid="sidebar-user-settings"
                  onClick={() => navigate(buildPath('/preferences/general'))}
                >
                  <Settings className="icon-sm" />
                  {t('settings.title')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem data-testid="sidebar-logout" onClick={logout}>
                  <LogOut className="icon-sm" />
                  {t('auth.logout')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                data-testid="sidebar-settings"
                onClick={() => navigate(buildPath('/preferences/general'))}
                className="ml-auto size-7 text-muted-foreground"
              >
                <Settings className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('settings.title')}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </ShadSidebarFooter>
  );
}
