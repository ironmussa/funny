import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';

import { useStableNavigate } from '@/hooks/use-stable-navigate';

/**
 * Writes `?panel=<id>` (or removes it) without a new history entry, so the URL
 * names the panel the user opened from the rail (openspec `tool-panels`).
 * `?tab=` belongs to the review panel and goes when another panel opens.
 */
export function usePanelParam(): (panel: string | null) => void {
  const navigate = useStableNavigate();
  const location = useLocation();
  return useCallback(
    (panel) => {
      const params = new URLSearchParams(location.search);
      if (panel) params.set('panel', panel);
      else params.delete('panel');
      if (panel !== 'review') params.delete('tab');
      const search = params.toString();
      navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true });
    },
    [location.pathname, location.search, navigate],
  );
}
