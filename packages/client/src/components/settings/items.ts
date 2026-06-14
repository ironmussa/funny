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
  UserPlus,
  Users,
  UsersRound,
  type LucideIcon,
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
export type SettingsItemId =
  | (typeof baseSettingsItems)[number]['id']
  | 'users'
  | 'team-members'
  | 'collaborators';

export interface SettingsNavItem {
  id: SettingsItemId;
  label: string;
  icon: LucideIcon;
}

/**
 * Project-config tabs mutate shared, server-owned project state, so they're
 * limited to the project's admins. Plain collaborators get a read-only
 * experience (the tabs are hidden; the server also rejects their writes).
 */
const PROJECT_ADMIN_ONLY_TABS: ReadonlySet<string> = new Set(['general', 'startup-commands']);

/**
 * Builds the settings menu for the current context, applying the same
 * project-admin / server-admin gating in one place so the desktop sidebar and
 * the mobile settings list never drift apart.
 */
export function buildSettingsItems(opts: {
  selectedProjectId: string | null;
  isProjectAdmin: boolean;
  isServerAdmin: boolean;
}): SettingsNavItem[] {
  const { selectedProjectId, isProjectAdmin, isServerAdmin } = opts;

  // Hide "Archived Threads" in per-project settings (it's a global view).
  let items: SettingsNavItem[] = selectedProjectId
    ? [...baseSettingsItems].filter((item) => item.id !== 'archived-threads')
    : [...baseSettingsItems];

  if (selectedProjectId) {
    if (!isProjectAdmin) {
      // Collaborators may freely configure their OWN runner/checkout (worktrees,
      // hooks, MCP, skills, .funny.json all proxy to their personal runner).
      // Only the shared, server-owned config is gated to project admins.
      items = items.filter((item) => !PROJECT_ADMIN_ONLY_TABS.has(item.id));
    } else {
      // Managing who can access THIS project is a project-admin action.
      items.push({ id: 'collaborators', label: 'Collaborators', icon: UserPlus });
    }
  } else if (isServerAdmin) {
    // Global context, server admins only.
    items.push({ id: 'users', label: 'Users', icon: Users });
    items.push({ id: 'team-members', label: 'Team Members', icon: UsersRound });
  }

  return items;
}

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
  collaborators: 'Collaborators',
};
