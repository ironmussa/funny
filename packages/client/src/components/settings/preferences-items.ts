import { SiGithub } from '@icons-pack/react-simple-icons';
import {
  Bot,
  Boxes,
  Building2,
  Cpu,
  KeyRound,
  Mail,
  Mic,
  Palette,
  Plug,
  Puzzle,
  Server,
  SlidersHorizontal,
  Sparkles,
  Users,
  UsersRound,
} from 'lucide-react';

export type GeneralPage =
  | 'general'
  | 'models'
  | 'appearance'
  | 'github'
  | 'github-app'
  | 'api-tokens'
  | 'ai-keys'
  | 'speech'
  | 'email'
  | 'users'
  | 'organizations'
  | 'team-members'
  | 'runners'
  | 'sandboxes'
  | 'system'
  | 'extensions'
  | 'providers'
  | 'agent-profiles'
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
  { id: 'github-app', label: 'GitHub App', icon: SiGithub },
  { id: 'api-tokens', label: 'settings.apiTokens', icon: KeyRound },
  { id: 'ai-keys', label: 'AI Providers', icon: Bot },
  { id: 'agent-profiles', label: 'settings.agentProfiles', icon: Bot },
  { id: 'speech', label: 'Speech', icon: Mic },
  { id: 'email', label: 'Email (SMTP)', icon: Mail },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'organizations', label: 'settings.organizations', icon: Building2 },
  { id: 'team-members', label: 'Team Members', icon: UsersRound },
  { id: 'runners', label: 'settings.runners', icon: Server },
  { id: 'sandboxes', label: 'settings.sandboxes', icon: Boxes },
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
  'github-app',
  'users',
  'organizations',
  'team-members',
  'extensions',
  'system',
]);

/** The Preferences pages a user can open, in sidebar order. */
export function buildPreferencesItems({ isAdmin }: { isAdmin: boolean }) {
  return isAdmin
    ? PREFERENCES_NAV_ITEMS
    : PREFERENCES_NAV_ITEMS.filter((item) => !ADMIN_ONLY_PREFERENCES.has(item.id));
}

/** Label of a Preferences page: an i18n key (`settings.*`) or literal text. */
export function preferencesItemLabel(label: string, t: (key: string) => string): string {
  return label.startsWith('settings.') ? t(label) : label;
}
