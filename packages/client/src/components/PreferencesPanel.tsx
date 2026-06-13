import { SiGithub } from '@icons-pack/react-simple-icons';
import {
  ArrowLeft,
  Bot,
  Building2,
  Cpu,
  Mail,
  Mic,
  Palette,
  Plug,
  Puzzle,
  Server,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { buildPath } from '@/lib/url';
import { useAuthStore } from '@/stores/auth-store';
import { useUIStore } from '@/stores/ui-store';

export type GeneralPage =
  | 'general'
  | 'models'
  | 'appearance'
  | 'github'
  | 'ai-keys'
  | 'speech'
  | 'email'
  | 'organizations'
  | 'runners'
  | 'system'
  | 'extensions'
  | 'providers'
  | 'agent-templates';

export const PREFERENCES_NAV_ITEMS: Array<{
  id: GeneralPage;
  label: string;
  icon: typeof SlidersHorizontal;
}> = [
  { id: 'general', label: 'settings.general', icon: SlidersHorizontal },
  { id: 'providers', label: 'Providers', icon: Plug },
  { id: 'models', label: 'settings.models', icon: Sparkles },
  { id: 'appearance', label: 'settings.appearance', icon: Palette },
  { id: 'github', label: 'GitHub', icon: SiGithub },
  { id: 'ai-keys', label: 'AI Providers', icon: Bot },
  { id: 'speech', label: 'Speech', icon: Mic },
  { id: 'email', label: 'Email (SMTP)', icon: Mail },
  { id: 'organizations', label: 'settings.organizations', icon: Building2 },
  { id: 'runners', label: 'settings.runners', icon: Server },
  { id: 'agent-templates', label: 'settings.agentTemplates', icon: Bot },
  { id: 'extensions', label: 'Extensions', icon: Puzzle },
  { id: 'system', label: 'settings.system', icon: Cpu },
];

/**
 * Instance-wide preference pages — only meaningful to the server admin. Hidden
 * from non-admins (some are already enforced server-side via requireAdmin;
 * hiding keeps the menu honest and avoids dead-ends). Organizations is here
 * because, under the project-collaborator model, orgs are an optional admin
 * grouping rather than a per-user concern.
 */
export const ADMIN_ONLY_PREFERENCES: ReadonlySet<GeneralPage> = new Set([
  'email',
  'organizations',
  'extensions',
  'system',
]);

export function preferencesPageLabel(page: GeneralPage, t: (key: string) => string): string {
  const item = PREFERENCES_NAV_ITEMS.find((i) => i.id === page);
  if (!item) return page;
  return item.label.startsWith('settings.') ? t(item.label) : item.label;
}

export function PreferencesPanelBody() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const activePreferencesPage = useUIStore((s) => s.activePreferencesPage) as GeneralPage;
  const settingsReturnPath = useUIStore((s) => s.settingsReturnPath);
  const setSettingsReturnPath = useUIStore((s) => s.setSettingsReturnPath);
  const setGeneralSettingsOpen = useUIStore((s) => s.setGeneralSettingsOpen);
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const navItems = isAdmin
    ? PREFERENCES_NAV_ITEMS
    : PREFERENCES_NAV_ITEMS.filter((item) => !ADMIN_ONLY_PREFERENCES.has(item.id));

  return (
    <>
      <SidebarHeader className="px-4 py-3">
        <div className="flex items-center gap-2">
          <TooltipIconButton
            onClick={() => {
              setGeneralSettingsOpen(false);
              const target = settingsReturnPath ?? '/';
              setSettingsReturnPath(null);
              navigate(buildPath(target));
            }}
            className="text-muted-foreground hover:text-foreground"
            data-testid="preferences-back"
            tooltip={t('common.back')}
          >
            <ArrowLeft className="icon-sm" />
          </TooltipIconButton>
          <h1 className="text-sm font-medium">{t('settings.title')}</h1>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-2 pb-2">
        <SidebarMenu>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  isActive={activePreferencesPage === item.id}
                  onClick={() => navigate(buildPath(`/preferences/${item.id}`))}
                  data-testid={`preferences-nav-${item.id}`}
                >
                  <Icon className="icon-base" />
                  <span>{item.label.startsWith('settings.') ? t(item.label) : item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>
    </>
  );
}

export function PreferencesPanel() {
  return (
    <Sidebar collapsible="offcanvas">
      <PreferencesPanelBody />
    </Sidebar>
  );
}
