import { create } from 'zustand';

import type { SettingId } from '@/components/settings/settings-index';

/**
 * Settings sidebar filter (openspec `settings-filter`). One query shared by
 * Preferences and Project Settings, so the cross-surface hint opens the other
 * surface with the same text and the text survives page changes. In memory
 * only; cleared when the user leaves settings.
 */
interface SettingsFilterState {
  query: string;
  /** Element the content pane should scroll to and highlight once mounted. */
  focusId: SettingId | null;
  setQuery: (query: string) => void;
  setFocusId: (id: SettingId | null) => void;
  reset: () => void;
}

export const useSettingsFilterStore = create<SettingsFilterState>()((set) => ({
  query: '',
  focusId: null,
  setQuery: (query) => set({ query }),
  setFocusId: (focusId) => set({ focusId }),
  reset: () => set({ query: '', focusId: null }),
}));
