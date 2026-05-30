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
  // Always-current location for the deferred invariant check below. Reading the
  // effect closure's `location` from a setTimeout fires stale: during a thread
  // switch the user navigates to a new URL, but the timer (scheduled before the
  // route re-rendered) would re-select the PREVIOUS URL's thread. The ref is
  // updated every render, so the timer always sees the live URL.
  const locationRef = useRef(location);
  locationRef.current = location;

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
  //
  // The re-select is DEFERRED and coalesced, not synchronous. Three callers
  // drive `selectThread` (this guard, `applyThreadRoute`, `ThreadList`'s click
  // handler which also navigates). During a thread switch / branch checkout /
  // focus-resync, `selectThread` is async (selectedThreadId set now, activeThread
  // later), so the store passes through transient splits. Re-selecting on every
  // one of those ticks made the three controllers chase each other in a ~50-300ms
  // ping-pong that flickered the tab title and hammered selectProject/fetchBranch.
  // Instead we debounce: rapid churn keeps rescheduling, and we only correct once
  // the store settles — and only if a real divergence remains AND no selectThread
  // is in flight.
  useEffect(() => {
    if (!initialized) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const checkInvariant = () => {
      timer = null;
      // Read the LIVE location (via ref), not the effect closure — see locationRef.
      const { threadId } = parseRoute(locationRef.current.pathname);
      if (!threadId) return;
      const ui = useUIStore.getState();
      if (ui.newThreadIsScratch || ui.newThreadProjectId) return;
      // A selectThread (this URL's or another's) is still settling — don't fight
      // it; its completion will fire another store change and reschedule us.
      if (getSelectingThreadId() !== null) return;
      const state = useThreadStore.getState();
      if (state.activeThread?.id === threadId) return;
      if (state.selectedThreadId === threadId && state.activeThread === null) return;
      routeSyncLog.warn('invariant re-select', {
        urlThreadId: threadId,
        storeActiveId: state.activeThread?.id ?? 'null',
        storeSelectedId: state.selectedThreadId ?? 'null',
      });
      state.selectThread(threadId);
    };

    const unsubscribe = useThreadStore.subscribe((state, prev) => {
      if (
        state.activeThread === prev.activeThread &&
        state.selectedThreadId === prev.selectedThreadId
      ) {
        return;
      }
      clearTimer();
      timer = setTimeout(checkInvariant, 200);
    });
    return () => {
      clearTimer();
      unsubscribe();
    };
    // Subscribe once — the check reads the live URL from locationRef, so it does
    // not need to re-subscribe on every navigation.
  }, [initialized]);
}
