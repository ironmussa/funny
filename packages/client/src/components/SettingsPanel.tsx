import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ArrowLeft,
  Settings,
  Server,
  Sparkles,
  GitBranch,
  GitFork,
  Terminal,
  Timer,
  Archive,
} from 'lucide-react';

export const settingsItems = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'mcp-server', label: 'MCP Server', icon: Server },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'worktrees', label: 'Worktrees', icon: GitFork },
  { id: 'startup-commands', label: 'Startup Commands', icon: Terminal },
  { id: 'automations', label: 'Automations', icon: Timer },
  { id: 'archived-threads', label: 'Archived Threads', icon: Archive },
] as const;

export type SettingsItemId = (typeof settingsItems)[number]['id'];

export const settingsLabelKeys: Record<string, string> = {
  general: 'settings.general',
  'mcp-server': 'settings.mcpServer',
  skills: 'settings.skills',
  git: 'settings.gitSettings',
  worktrees: 'settings.worktrees',
  'startup-commands': 'startup.title',
  automations: 'settings.automations',
  'archived-threads': 'settings.archivedThreads',
};

export function SettingsPanel() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const setSettingsOpen = useAppStore(s => s.setSettingsOpen);
  const activeSettingsPage = useAppStore(s => s.activeSettingsPage);
  const selectedProjectId = useAppStore(s => s.selectedProjectId);

  const settingsPath = (pageId: string) =>
    selectedProjectId
      ? `/projects/${selectedProjectId}/settings/${pageId}`
      : `/settings/${pageId}`;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-border flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            setSettingsOpen(false);
            navigate(selectedProjectId ? `/projects/${selectedProjectId}` : '/');
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <h1 className="text-sm font-semibold tracking-tight">{t('settings.title')}</h1>
      </div>

      {/* Menu list */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {settingsItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => navigate(settingsPath(item.id))}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors',
                  activeSettingsPage === item.id
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span>{t(settingsLabelKeys[item.id] ?? item.label)}</span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
