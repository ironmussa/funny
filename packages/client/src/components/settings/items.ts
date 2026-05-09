import {
  Settings,
  Server,
  Sparkles,
  GitFork,
  Terminal,
  FileJson2,
  Webhook,
  Timer,
  Archive,
  Workflow,
} from 'lucide-react';

const baseSettingsItems = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'mcp-server', label: 'MCP Server', icon: Server },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'worktrees', label: 'Worktrees', icon: GitFork },
  { id: 'startup-commands', label: 'Startup Commands', icon: Terminal },
  { id: 'project-config', label: 'Project Config', icon: FileJson2 },
  { id: 'hooks', label: 'Hooks', icon: Webhook },
  { id: 'automations', label: 'Automations', icon: Timer },
  { id: 'pipelines', label: 'Pipelines', icon: Workflow },
  { id: 'archived-threads', label: 'Archived Threads', icon: Archive },
] as const;

export const settingsItems = baseSettingsItems;
export type SettingsItemId = (typeof baseSettingsItems)[number]['id'] | 'users' | 'team-members';

export const settingsLabelKeys: Record<string, string> = {
  general: 'settings.general',
  'mcp-server': 'settings.mcpServer',
  skills: 'settings.skills',
  worktrees: 'settings.worktrees',
  'startup-commands': 'startup.title',
  'project-config': 'projectConfig.title',
  hooks: 'hooks.title',
  automations: 'settings.automations',
  pipelines: 'settings.pipelines',
  'archived-threads': 'settings.archivedThreads',
  users: 'users.title',
  'team-members': 'Team Members',
};
