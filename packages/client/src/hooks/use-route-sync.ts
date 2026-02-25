import { useEffect } from 'react';
import { useLocation, matchPath } from 'react-router-dom';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';
import { settingsItems } from '@/components/SettingsPanel';

function parseRoute(pathname: string) {
  // Project-scoped settings: /projects/:projectId/settings/:pageId
  const projectSettingsMatch = matchPath('/projects/:projectId/settings/:pageId', pathname);
  if (projectSettingsMatch) {
    return {
      settingsPage: projectSettingsMatch.params.pageId!,
      projectId: projectSettingsMatch.params.projectId!,
      threadId: null,
      globalSearch: false,
      inbox: false,
      analytics: false,
      liveColumns: false,
    };
  }

  const settingsMatch = matchPath('/settings/:pageId', pathname);
  if (settingsMatch) {
    return {
      settingsPage: settingsMatch.params.pageId!,
      projectId: null,
      threadId: null,
      globalSearch: false,
      inbox: false,
      analytics: false,
      liveColumns: false,
    };
  }

  const threadMatch = matchPath(
    '/projects/:projectId/threads/:threadId',
    pathname
  );
  if (threadMatch) {
    return {
      settingsPage: null,
      projectId: threadMatch.params.projectId!,
      threadId: threadMatch.params.threadId!,
      globalSearch: false,
      inbox: false,
      analytics: false,
      liveColumns: false,
    };
  }

  const projectMatch = matchPath('/projects/:projectId', pathname);
  if (projectMatch) {
    return {
      settingsPage: null,
      projectId: projectMatch.params.projectId!,
      threadId: null,
      globalSearch: false,
      inbox: false,
      analytics: false,
      liveColumns: false,
    };
  }

  // Automation inbox: /inbox
  if (pathname === '/inbox') {
    return { settingsPage: null, projectId: null, threadId: null, globalSearch: false, inbox: true, analytics: false, liveColumns: false };
  }

  // Search: /search (with optional ?project=<id> query param)
  if (pathname === '/search') {
    return { settingsPage: null, projectId: null, threadId: null, globalSearch: true, inbox: false, analytics: false, liveColumns: false };
  }

  // Project-scoped analytics: /projects/:projectId/analytics
  const projectAnalyticsMatch = matchPath('/projects/:projectId/analytics', pathname);
  if (projectAnalyticsMatch) {
    return { settingsPage: null, projectId: projectAnalyticsMatch.params.projectId!, threadId: null, globalSearch: false, inbox: false, analytics: true, liveColumns: false };
  }

  // Analytics: /analytics
  if (pathname === '/analytics') {
    return { settingsPage: null, projectId: null, threadId: null, globalSearch: false, inbox: false, analytics: true, liveColumns: false };
  }

  // Grid columns: /grid
  if (pathname === '/grid') {
    return { settingsPage: null, projectId: null, threadId: null, globalSearch: false, inbox: false, analytics: false, liveColumns: true };
  }

  return { settingsPage: null, projectId: null, threadId: null, globalSearch: false, inbox: false, analytics: false, liveColumns: false };
}

const validSettingsIds = new Set(settingsItems.map((i) => i.id));

export function useRouteSync() {
  const location = useLocation();
  // Subscribe only to `initialized` from project-store (not the entire app state)
  const initialized = useProjectStore(s => s.initialized);

  // Sync URL → store whenever location changes (wait for auth + projects first)
  useEffect(() => {
    if (!initialized) return;

    const { settingsPage, projectId, threadId, globalSearch, inbox, analytics, liveColumns } = parseRoute(location.pathname);
    // Use imperative getState() to avoid subscribing to store changes
    const projectStore = useProjectStore.getState();
    const threadStore = useThreadStore.getState();
    const uiStore = useUIStore.getState();

    if (settingsPage && validSettingsIds.has(settingsPage as any)) {
      if (!uiStore.settingsOpen) uiStore.setSettingsOpen(true);
      if (uiStore.activeSettingsPage !== settingsPage) uiStore.setActiveSettingsPage(settingsPage);
      if (projectId && projectId !== projectStore.selectedProjectId) projectStore.selectProject(projectId);
      return;
    }

    // Close settings if navigating away from /settings
    if (uiStore.settingsOpen) {
      uiStore.setSettingsOpen(false);
    }

    // Automation inbox route
    if (inbox) {
      if (!uiStore.automationInboxOpen) {
        uiStore.setAutomationInboxOpen(true);
      }
      return;
    }

    // Close automation inbox when navigating away from /inbox
    if (uiStore.automationInboxOpen) {
      uiStore.setAutomationInboxOpen(false);
    }

    // Analytics view
    if (analytics) {
      if (projectId && projectId !== projectStore.selectedProjectId) {
        projectStore.selectProject(projectId);
      }
      if (!uiStore.analyticsOpen) {
        uiStore.setAnalyticsOpen(true);
      }
      return;
    }

    // Close analytics when navigating away
    if (uiStore.analyticsOpen) {
      uiStore.setAnalyticsOpen(false);
    }

    // Live columns view
    if (liveColumns) {
      if (!uiStore.liveColumnsOpen) {
        uiStore.setLiveColumnsOpen(true);
      }
      return;
    }

    // Close live columns when navigating away
    if (uiStore.liveColumnsOpen) {
      uiStore.setLiveColumnsOpen(false);
    }

    // Search view: /search (with optional ?project= query param)
    if (globalSearch) {
      if (uiStore.allThreadsProjectId !== '__all__') {
        uiStore.showGlobalSearch();
      }
      // Clear kanban context when arriving at /search so both state changes
      // (allThreadsProjectId + kanbanContext) happen in the same effect tick,
      // preventing the back arrow from flashing in ProjectHeader.
      if (uiStore.kanbanContext) {
        uiStore.setKanbanContext(null);
      }
      return;
    }

    // Clear search view if navigating away
    if (uiStore.allThreadsProjectId) {
      uiStore.closeAllThreads();
    }

    if (threadId) {
      // Re-select if the thread ID changed, or if the thread ID matches but
      // activeThread failed to load (e.g. due to a race condition or API error).
      if (threadId !== threadStore.selectedThreadId || !threadStore.activeThread || threadStore.activeThread.id !== threadId) {
        threadStore.selectThread(threadId);
      }
      if (projectId && projectId !== projectStore.selectedProjectId) {
        projectStore.selectProject(projectId);
      }
    } else if (projectId) {
      if (threadStore.selectedThreadId) {
        threadStore.selectThread(null);
      }
      if (projectId !== projectStore.selectedProjectId) {
        projectStore.selectProject(projectId);
      }
    } else {
      // Root path — clear selection
      if (threadStore.selectedThreadId) threadStore.selectThread(null);
      if (projectStore.selectedProjectId) projectStore.selectProject(null);
    }
  }, [location.pathname, initialized]);
}
