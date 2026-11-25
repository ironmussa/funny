import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { useProjectById } from '@/data/projects/hooks';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsFilterStore } from '@/stores/settings-filter-store';

import { buildSettingsItems, settingsLabelKeys } from './items';
import { buildPreferencesItems, preferencesItemLabel } from './preferences-items';
import {
  matchSettingEntry,
  normalizeSettingsQuery,
  type FilterPage,
  type Translate,
} from './settings-filter';
import { getSettingEntry, type SettingId } from './settings-index';

export interface SettingsNavPage extends FilterPage {
  icon: LucideIcon | ComponentType<{ className?: string }>;
}

/** `t` in the active language and in English, as the matcher expects them. */
export function useSettingsTranslators(): { t: Translate; tEn: Translate } {
  const { t, i18n } = useTranslation();
  return useMemo(() => {
    // Created on first use: every indexed row calls this hook, and with an
    // empty filter nothing needs the English text. Held in an object rather
    // than a reassigned variable, which React Compiler cannot compile.
    interface EnglishTranslator {
      t?: ReturnType<typeof i18n.getFixedT>;
    }
    const english: EnglishTranslator = {};
    return {
      t: (key, defaultValue) => String(t(key, { defaultValue })),
      tEn: (key, defaultValue) => {
        if (!english.t) english.t = i18n.getFixedT('en');
        return String(english.t(key, { defaultValue }));
      },
    };
  }, [t, i18n]);
}

/** The Preferences pages this user can open, with labels in both languages. */
export function usePreferencesNavPages(): SettingsNavPage[] {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const { t: tr, tEn } = useSettingsTranslators();
  return useMemo(
    () =>
      buildPreferencesItems({ isAdmin }).map((item) => ({
        id: item.id,
        icon: item.icon,
        label: preferencesItemLabel(item.label, (k) => tr(k, k)),
        labelEn: preferencesItemLabel(item.label, (k) => tEn(k, k)),
      })),
    [isAdmin, tr, tEn],
  );
}

/** The selected project and the settings pages this user can open for it. */
interface ProjectSettingsNavPages {
  selectedProjectId: string | null;
  pages: SettingsNavPage[];
}

/**
 * The project settings pages this user can open for the selected project.
 * The role rules are the ones `buildSettingsItems` applies.
 */
export function useProjectSettingsNavPages(): ProjectSettingsNavPages {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectedProject = useProjectById(selectedProjectId);
  const authUserId = useAuthStore((s) => s.user?.id);
  const { t: tr, tEn } = useSettingsTranslators();

  // Project-config tabs mutate shared project state, so they're limited to the
  // project's admins (owner or `admin` member). The owner fallback covers
  // older payloads that predate the `role` field.
  const isProjectAdmin =
    selectedProject?.role === 'owner' ||
    selectedProject?.role === 'admin' ||
    (!!selectedProject && selectedProject.userId === authUserId);
  const isProjectOwner = !!selectedProject && selectedProject.userId === authUserId;

  const pages = useMemo(
    () =>
      buildSettingsItems({ selectedProjectId, isProjectAdmin, isProjectOwner }).map((item) => {
        const key = settingsLabelKeys[item.id] ?? item.label;
        return {
          id: item.id,
          icon: item.icon,
          label: tr(key, item.label),
          labelEn: tEn(key, item.label),
        };
      }),
    [selectedProjectId, isProjectAdmin, isProjectOwner, tr, tEn],
  );
  return { selectedProjectId, pages };
}

/**
 * Whether an indexed element should be dimmed: the filter is not empty and the
 * element does not match it. `null` (an element that is not indexed) is never
 * dimmed.
 */
export function useSettingDimmed(id: SettingId | null): boolean {
  const query = useSettingsFilterStore((s) => s.query);
  const { t, tEn } = useSettingsTranslators();
  return useMemo(() => {
    const q = normalizeSettingsQuery(query);
    if (!q || !id) return false;
    return matchSettingEntry(getSettingEntry(id), q, t, tEn) < 0;
  }, [query, id, t, tEn]);
}

/** How long to wait for a focused element that renders after its data loads. */
const FOCUS_WAIT_MS = 2000;
const HIGHLIGHT_CLASS = 'setting-focus-highlight';

function highlight(el: Element) {
  el.scrollIntoView({ block: 'center' });
  el.classList.remove(HIGHLIGHT_CLASS);
  el.classList.add(HIGHLIGHT_CLASS);
  el.addEventListener('animationend', () => el.classList.remove(HIGHLIGHT_CLASS), { once: true });
}

/**
 * Scrolls to and highlights the element the sidebar filter selected. Mounted
 * once by each settings content pane. Rows that render after their data loads
 * are waited for, up to FOCUS_WAIT_MS; then the page is left as it is.
 */
export function useSettingFocusScroll(): void {
  const focusId = useSettingsFilterStore((s) => s.focusId);
  const setFocusId = useSettingsFilterStore((s) => s.setFocusId);

  useEffect(() => {
    if (!focusId) return;
    const selector = `[data-setting-id="${focusId}"]`;
    const existing = document.querySelector(selector);
    if (existing) {
      highlight(existing);
      setFocusId(null);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (!el) return;
      observer.disconnect();
      window.clearTimeout(timer);
      highlight(el);
      setFocusId(null);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setTimeout(() => {
      observer.disconnect();
      setFocusId(null);
    }, FOCUS_WAIT_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [focusId, setFocusId]);
}
