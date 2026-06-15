import { describe, expect, it } from 'vitest';

import { ADMIN_ONLY_PREFERENCES, PREFERENCES_NAV_ITEMS } from '@/components/PreferencesPanel';
import { buildSettingsItems } from '@/components/settings/items';

/**
 * funny has exactly two settings surfaces: General (instance-wide, in the
 * Preferences panel) and per-project. User/team management used to also appear
 * in a parallel global `/settings` admin nav — the gear icon never opened it,
 * so admins couldn't find it. These guards keep the consolidation in place.
 */
describe('Settings surfaces — admin-global pages live in Preferences', () => {
  it('exposes Users and Team Members as admin-only Preferences pages', () => {
    for (const id of ['users', 'team-members'] as const) {
      const item = PREFERENCES_NAV_ITEMS.find((i) => i.id === id);
      expect(item, `${id} nav item`).toBeDefined();
      expect(ADMIN_ONLY_PREFERENCES.has(id), `${id} admin-gated`).toBe(true);
    }
  });

  it('keeps buildSettingsItems purely per-project (no global users/team-members)', () => {
    // Global context (no project): only personal/base items, no admin pages.
    const global = buildSettingsItems({ selectedProjectId: null, isProjectAdmin: false });
    const globalIds = global.map((i) => i.id);
    expect(globalIds).not.toContain('users');
    expect(globalIds).not.toContain('team-members');
    expect(globalIds).not.toContain('collaborators');

    // Per-project admin: Collaborators is the only access-management tab,
    // and Archived Threads is a per-project tab (not a global view).
    const projectAdmin = buildSettingsItems({ selectedProjectId: 'p1', isProjectAdmin: true });
    expect(projectAdmin.map((i) => i.id)).toContain('collaborators');
    expect(projectAdmin.map((i) => i.id)).toContain('archived-threads');
  });
});
