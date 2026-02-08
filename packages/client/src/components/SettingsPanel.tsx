import { useAppStore } from '@/stores/app-store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ArrowLeft,
  Settings,
  Wrench,
  Palette,
  Server,
  Sparkles,
  GitBranch,
  Monitor,
  GitFork,
  Archive,
} from 'lucide-react';

export const settingsItems = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'configuration', label: 'Configuration', icon: Wrench },
  { id: 'personalization', label: 'Personalization', icon: Palette },
  { id: 'mcp-server', label: 'MCP Server', icon: Server },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'environments', label: 'Environments', icon: Monitor },
  { id: 'worktrees', label: 'Worktrees', icon: GitFork },
  { id: 'archived-threads', label: 'Archived Threads', icon: Archive },
] as const;

export type SettingsItemId = (typeof settingsItems)[number]['id'];

export function SettingsPanel() {
  const { setSettingsOpen, activeSettingsPage, setActiveSettingsPage } = useAppStore();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-border flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setSettingsOpen(false)}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <h1 className="text-sm font-semibold tracking-tight">Settings</h1>
      </div>

      {/* Menu list */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {settingsItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => setActiveSettingsPage(item.id)}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors',
                  activeSettingsPage === item.id
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
