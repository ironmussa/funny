import { describe, expect, it } from 'bun:test';

import { buildSettingsItems, routableSettingsIds } from '@/components/settings/items';
import {
  ADMIN_ONLY_PREFERENCES,
  buildPreferencesItems,
  PREFERENCES_NAV_ITEMS,
} from '@/components/settings/preferences-items';
import {
  countSettingsResults,
  filterSettings,
  matchSettingEntry,
  normalizeSettingsQuery,
  type FilterPage,
  type Translate,
} from '@/components/settings/settings-filter';
import {
  getSettingEntry,
  SETTINGS_INDEX,
  SETTINGS_PAGE_KEYWORDS,
} from '@/components/settings/settings-index';
import en from '@/locales/en/translation.json';
import es from '@/locales/es/translation.json';

// openspec settings-filter: the sidebar filter matches page names and the
// static elements indexed for each page, in the active language and English.

function translator(dict: Record<string, unknown>): Translate {
  return (key, defaultValue) => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
        dict,
      );
    return typeof value === 'string' ? value : defaultValue;
  };
}

const tEn = translator(en);
const tEs = translator(es);

function preferencesPages(isAdmin: boolean): FilterPage[] {
  return buildPreferencesItems({ isAdmin }).map((item) => {
    const label = item.label.startsWith('settings.') ? tEn(item.label, item.label) : item.label;
    return { id: item.id, label, labelEn: label };
  });
}

function projectPages(isProjectAdmin: boolean): FilterPage[] {
  return buildSettingsItems({ selectedProjectId: 'p1', isProjectAdmin, isProjectOwner: true }).map(
    (item) => ({ id: item.id, label: item.label, labelEn: item.label }),
  );
}

function run(scope: 'preferences' | 'project', pages: FilterPage[], query: string, t = tEn) {
  return filterSettings({ scope, pages, query: normalizeSettingsQuery(query), t, tEn });
}

describe('settings index', () => {
  it('points every entry at a page of its surface', () => {
    const preferencePages = new Set<string>(PREFERENCES_NAV_ITEMS.map((i) => i.id));
    for (const entry of SETTINGS_INDEX) {
      const valid = entry.scope === 'preferences' ? preferencePages : routableSettingsIds;
      expect(valid.has(entry.page), `${entry.id} → ${entry.page}`).toBe(true);
    }
    for (const page of Object.keys(SETTINGS_PAGE_KEYWORDS.preferences)) {
      expect(preferencePages.has(page), `preferences keywords for ${page}`).toBe(true);
    }
    for (const page of Object.keys(SETTINGS_PAGE_KEYWORDS.project)) {
      expect(routableSettingsIds.has(page), `project keywords for ${page}`).toBe(true);
    }
  });

  it('has unique ids', () => {
    const ids = SETTINGS_INDEX.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildPreferencesItems', () => {
  it('shows admins every page and hides admin-only pages from others', () => {
    expect(buildPreferencesItems({ isAdmin: true })).toHaveLength(PREFERENCES_NAV_ITEMS.length);
    const ids = buildPreferencesItems({ isAdmin: false }).map((i) => i.id);
    for (const id of ADMIN_ONLY_PREFERENCES) expect(ids).not.toContain(id);
    expect(ids).toContain('appearance');
  });
});

describe('filterSettings', () => {
  it('returns nothing for an empty query', () => {
    expect(run('preferences', preferencesPages(true), '   ')).toEqual([]);
  });

  it('finds a setting inside a page whose name does not match', () => {
    const results = run('preferences', preferencesPages(true), 'font');
    const appearance = results.find((r) => r.page.id === 'appearance');
    expect(appearance?.pageMatched).toBe(false);
    expect(appearance?.elements.map((e) => e.id)).toContain('appearance.font-size');
  });

  it('finds a section header', () => {
    const results = run('project', projectPages(true), 'recommended servers');
    expect(results.map((r) => r.page.id)).toEqual(['mcp-server']);
    expect(results[0]!.elements.map((e) => e.id)).toEqual(['mcp-server.recommended']);
  });

  it('shows a page whose name matches with no sub-items', () => {
    const results = run('project', projectPages(true), 'hooks');
    const hooks = results.find((r) => r.page.id === 'hooks');
    expect(hooks).toEqual({
      page: expect.objectContaining({ id: 'hooks' }),
      pageMatched: true,
      elements: [],
    });
  });

  it('matches page keywords (pages whose content is user data)', () => {
    const results = run('preferences', preferencesPages(true), 'smtp');
    expect(results.map((r) => r.page.id)).toContain('email');
  });

  it('returns no pages when nothing matches', () => {
    expect(run('preferences', preferencesPages(true), 'zzz-no-such-setting')).toEqual([]);
  });

  it('matches the English title while the UI is in Spanish', () => {
    const results = run('preferences', preferencesPages(true), 'font size', tEs);
    const ids = results.flatMap((r) => r.elements.map((e) => e.id));
    expect(ids).toContain('appearance.font-size');
  });

  it('matches the Spanish title, ignoring accents', () => {
    const entry = getSettingEntry('general.language');
    const spanish = tEs(entry.title, entry.title);
    expect(spanish).not.toBe(tEn(entry.title, entry.title));
    const query = normalizeSettingsQuery(spanish.normalize('NFD').replace(/\p{M}/gu, ''));
    expect(matchSettingEntry(entry, query, tEs, tEn)).toBe(0);
  });

  it('ranks title matches before description and keyword matches', () => {
    const results = run('project', projectPages(true), 'model');
    const general = results.find((r) => r.page.id === 'general')!;
    expect(general.elements[0]!.id).toBe('project-general.default-model');
  });

  it('never returns elements of pages the user cannot open', () => {
    const nonAdmin = run('preferences', preferencesPages(false), 'gitoxide');
    expect(nonAdmin).toEqual([]);
    const admin = run('preferences', preferencesPages(true), 'gitoxide');
    expect(admin.map((r) => r.page.id)).toEqual(['system']);

    // A collaborator who is not a project admin has no General page.
    const collaborator = run('project', projectPages(false), 'default branch');
    expect(collaborator.map((r) => r.page.id)).not.toContain('general');
  });

  it('counts elements, and pages that matched only by name', () => {
    const results = run('project', projectPages(true), 'hooks');
    expect(countSettingsResults(results)).toBeGreaterThanOrEqual(1);
    const font = run('preferences', preferencesPages(true), 'font size');
    expect(countSettingsResults(font)).toBe(1);
  });
});
