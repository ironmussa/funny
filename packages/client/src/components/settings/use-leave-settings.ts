import { useNavigate } from 'react-router-dom';

import { buildPath } from '@/lib/url';
import { useSettingsFilterStore } from '@/stores/settings-filter-store';
import { useUIStore } from '@/stores/ui-store';

/**
 * The back button of Settings and Preferences: return where the member came
 * from (or `fallback`), forgetting that path and the sidebar filter.
 *
 * It does not close the overlay imperatively — route-sync closes it AFTER the
 * URL becomes the thread route. Closing it here reveals ThreadView one render
 * before the URL updates, flashing the empty new-thread compose input. See
 * use-view-route-sync.ts.
 */
export function useLeaveSettings(fallback: string): () => void {
  const navigate = useNavigate();
  const settingsReturnPath = useUIStore((s) => s.settingsReturnPath);
  const setSettingsReturnPath = useUIStore((s) => s.setSettingsReturnPath);
  const resetFilter = useSettingsFilterStore((s) => s.reset);
  return () => {
    const target = settingsReturnPath ?? fallback;
    setSettingsReturnPath(null);
    resetFilter();
    navigate(buildPath(target));
  };
}
