import {
  ArrowLeft,
  Bot,
  Building2,
  Cpu,
  Github,
  Mail,
  Mic,
  Palette,
  Server,
  SlidersHorizontal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { PreferencesContent } from '@/components/general-settings/PreferencesContent';
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
import { useUIStore } from '@/stores/ui-store';

type GeneralPage =
  | 'general'
  | 'appearance'
  | 'github'
  | 'ai-keys'
  | 'speech'
  | 'email'
  | 'organizations'
  | 'runners'
  | 'system'
  | 'agent-templates';

const NAV_ITEMS: Array<{ id: GeneralPage; label: string; icon: typeof SlidersHorizontal }> = [
  { id: 'general', label: 'settings.general', icon: SlidersHorizontal },
  { id: 'appearance', label: 'settings.appearance', icon: Palette },
  { id: 'github', label: 'GitHub', icon: Github },
  { id: 'ai-keys', label: 'AI Providers', icon: Bot },
  { id: 'speech', label: 'Speech', icon: Mic },
  { id: 'email', label: 'Email (SMTP)', icon: Mail },
  { id: 'organizations', label: 'settings.organizations', icon: Building2 },
  { id: 'runners', label: 'settings.runners', icon: Server },
  { id: 'agent-templates', label: 'settings.agentTemplates', icon: Bot },
  { id: 'system', label: 'settings.system', icon: Cpu },
];

export function GeneralSettingsView() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const activePreferencesPage = useUIStore((s) => s.activePreferencesPage) as GeneralPage;

  return (
    <div className="flex h-full w-full">
      <Sidebar collapsible="offcanvas">
        <SidebarHeader className="px-4 py-3">
          <div className="flex items-center gap-2">
            <TooltipIconButton
              onClick={() => {
                const ui = useUIStore.getState();
                const target = ui.settingsReturnPath ?? '/';
                ui.setSettingsReturnPath(null);
                ui.setGeneralSettingsOpen(false);
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
            {NAV_ITEMS.map((item) => {
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
      </Sidebar>

      <PreferencesContent activePreferencesPage={activePreferencesPage} />
    </div>
  );
}
