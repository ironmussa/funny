import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { settingsItems } from '@/components/settings/items';
import { useProjectStore } from '@/stores/project-store';
import { setUrlThreadId } from '@/stores/thread-store';

import { parseRoute, type ParsedRoute } from './route-parser';
import { useOrgAutoSwitch } from './use-org-auto-switch';
import { useThreadProjectSync } from './use-thread-project-sync';
import { useViewRouteSync } from './use-view-route-sync';

const LAST_ROUTE_KEY = 'funny_last_route';

const validSettingsIds = new Set([...settingsItems.map((i) => i.id), 'collaborators']);

function isAnyRouteActive(parsed: ParsedRoute): boolean {
  return Boolean(
    parsed.projectId ||
    parsed.threadId ||
    parsed.settingsPage ||
    parsed.preferencesPage ||
    parsed.globalSearch ||
    parsed.inbox ||
    parsed.analytics ||
    parsed.liveColumns ||
    parsed.orchestrator ||
    parsed.addProject,
  );
}

function restoreLastRoute(navigate: (path: string, opts: { replace: boolean }) => void) {
  try {
    const lastRoute = localStorage.getItem(LAST_ROUTE_KEY);
    if (lastRoute && lastRoute.startsWith('/')) {
      navigate(lastRoute, { replace: true });
    }
  } catch {}
}

function persistCurrentRoute(pathname: string) {
  try {
    localStorage.setItem(LAST_ROUTE_KEY, pathname);
  } catch {}
}

export function useRouteSync() {
  const location = useLocation();
  const navigate = useNavigate();
  const initialized = useProjectStore((s) => s.initialized);
  const restoredRef = useRef(false);
  const prevNonSettingsPathRef = useRef<string | null>(null);

  const parsed = useMemo(() => parseRoute(location.pathname), [location.pathname]);

  // Mirror the URL's thread id into the store layer synchronously, every render,
  // so non-React store code — WS routing, refresh, eviction — reads the active
  // thread straight from the route. This is what makes the old invariant guard
  // unnecessary: nothing has to reconcile selectedThreadId/activeThread back to
  // the URL, because consumers read the URL directly.
  setUrlThreadId(parsed.threadId);

  // Cold-load: restore the last visited route at root path
  useEffect(() => {
    if (!initialized) return;
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (isAnyRouteActive(parsed)) return;
    restoreLastRoute(navigate);
  }, [initialized, parsed, navigate]);

  // Persist the current route while viewing a thread or project
  useEffect(() => {
    if (!initialized) return;
    if (!parsed.threadId && !parsed.projectId) return;
    persistCurrentRoute(location.pathname);
  }, [initialized, parsed.threadId, parsed.projectId, location.pathname]);

  // Track the last non-settings path so the back-arrow can return to it
  useEffect(() => {
    if (parsed.preferencesPage) return;
    if (parsed.settingsPage && validSettingsIds.has(parsed.settingsPage)) return;
    prevNonSettingsPathRef.current = location.pathname;
  }, [parsed.preferencesPage, parsed.settingsPage, location.pathname]);

  useOrgAutoSwitch(initialized, parsed.orgSlug);
  useViewRouteSync(initialized, parsed, prevNonSettingsPathRef);
  useThreadProjectSync(initialized, parsed);

  // NOTE: the old invariant guard (a debounced store subscriber that re-selected
  // the URL's thread whenever activeThread/selectedThreadId diverged) lived here.
  // It's gone: WS routing/refresh and the display now read the URL directly via
  // getUrlThreadId(), so a transient or external divergence of the store pointers
  // can't drop messages or stale the pane — there is nothing left to reconcile.
}
