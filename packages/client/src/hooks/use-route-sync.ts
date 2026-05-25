import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { settingsItems } from '@/components/settings/items';
import { createClientLogger } from '@/lib/client-logger';
import { useProjectStore } from '@/stores/project-store';
import { getSelectingThreadId, useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { parseRoute, type ParsedRoute } from './route-parser';
import { useOrgAutoSwitch } from './use-org-auto-switch';
import { useThreadProjectSync } from './use-thread-project-sync';
import { useViewRouteSync } from './use-view-route-sync';

const routeSyncLog = createClientLogger('route-sync');

const LAST_ROUTE_KEY = 'funny_last_route';

const validSettingsIds = new Set([...settingsItems.map((i) => i.id), 'users', 'team-members']);

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

  // Invariant guard: URL is the source of truth for which thread is active.
  // If anything (org switch, error path, external setState) makes
  // `activeThread` diverge from the URL's threadId while the URL hasn't
  // changed, the location-only effects above never re-fire — leaving
  // WS handlers to drop messages for the URL's thread because
  // `activeThread?.id !== threadId`. Subscribe to the store so any
  // divergence triggers a re-select.
  useEffect(() => {
    if (!initialized) return;
    const unsubscribe = useThreadStore.subscribe((state, prev) => {
      if (
        state.activeThread === prev.activeThread &&
        state.selectedThreadId === prev.selectedThreadId
      ) {
        return;
      }
      const { threadId } = parseRoute(location.pathname);
      if (!threadId) return;
      const ui = useUIStore.getState();
      if (ui.newThreadIsScratch || ui.newThreadProjectId) return;
      if (getSelectingThreadId() === threadId) return;
      if (state.activeThread?.id === threadId) return;
      if (state.selectedThreadId === threadId && state.activeThread === null) {
        return;
      }
      routeSyncLog.warn('invariant re-select', {
        urlThreadId: threadId,
        storeActiveId: state.activeThread?.id ?? 'null',
        storeSelectedId: state.selectedThreadId ?? 'null',
        prevActiveId: prev.activeThread?.id ?? 'null',
        prevSelectedId: prev.selectedThreadId ?? 'null',
      });
      useThreadStore.getState().selectThread(threadId);
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- location.pathname read at callback time
  }, [initialized, location.pathname]);
}
