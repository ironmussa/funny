import { useEffect } from 'react';
import { useLocation, matchPath } from 'react-router-dom';

import { settingsItems } from '@/components/SettingsPanel';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

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
      addProject: false,
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
      addProject: false,
    };
  }

  const threadMatch = matchPath('/projects/:projectId/threads/:threadId', pathname);
  if (threadMatch) {
    return {
      settingsPage: null,
      projectId: threadMatch.params.projectId!,
      threadId: threadMatch.params.threadId!,
      globalSearch: false,
      inbox: false,
      analytics: false,
      liveColumns: false,
      addProject: false,
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
      addProject: false,
    };
  }

  // Automation inbox: /inbox
  if (pathname === '/inbox') {
    return {
      settingsPage: null,
      projectId: null,
      threadId: null,
      globalSearch: false,
      inbox: true,
      analytics: false,
      liveColumns: false,
      addProject: false,
    };
  }

  // List view: /list (with optional ?project=<id> query param)
  if (pathname === '/list') {
    return {
      settingsPage: null,
      projectId: null,
      threadId: null,
      globalSearch: true,
      inbox: false,
      analytics: false,
      liveColumns: false,
      addProject: false,
    };
  }

  // Kanban view: /kanban (with optional ?project=<id> query param)
  if (pathname === '/kanban') {
    return {
      settingsPage: null,
      projectId: null,
      threadId: null,
      globalSearch: true,
      inbox: false,
      analytics: false,
      liveColumns: false,
      addProject: false,
    };
  }

  // Project-scoped analytics: /projects/:projectId/analytics
  const projectAnalyticsMatch = matchPath('/projects/:projectId/analytics', pathname);
  if (projectAnalyticsMatch) {
    return {
      settingsPage: null,
      projectId: projectAnalyticsMatch.params.projectId!,
      threadId: null,
      globalSearch: false,
      inbox: false,
      analytics: true,
      liveColumns: false,
      addProject: false,
    };
  }

  // Analytics: /analytics
  if (pathname === '/analytics') {
    return {
      settingsPage: null,
      projectId: null,
      threadId: null,
      globalSearch: false,
      inbox: false,
      analytics: true,
      liveColumns: false,
      addProject: false,
    };
  }

  // Grid columns: /grid
  if (pathname === '/grid') {
    return {
      settingsPage: null,
      projectId: null,
      threadId: null,
      globalSearch: false,
      inbox: false,
      analytics: false,
      liveColumns: true,
      addProject: false,
    };
  }

  // New project: /new
  if (pathname === '/new') {
    return {
      settingsPage: null,
      projectId: null,
      threadId: null,
      globalSearch: false,
      inbox: false,
      analytics: false,
      liveColumns: false,
      addProject: true,
    };
  }

  return {
    settingsPage: null,
    projectId: null,
    threadId: null,
    globalSearch: false,
    inbox: false,
    analytics: false,
    liveColumns: false,
    addProject: false,
  };
}

const validSettingsIds = new Set([
  ...settingsItems.map((i) => i.id),
  'users',
  'team-settings',
  'team-members',
  'team-invitations',
]);

export function useRouteSync() {
  const location = useLocation();
  // Subscribe only to `initialized` from project-store (not the entire app state)
  const initialized = useProjectStore((s) => s.initialized);

  // Sync URL → store whenever location changes (wait for auth + projects first)
  useEffect(() => {
    if (!initialized) return;

    const {
      settingsPage,
      projectId,
      threadId,
      globalSearch,
      inbox,
      analytics,
      liveColumns,
      addProject,
    } = parseRoute(location.pathname);
    // Use imperative getState() to avoid subscribing to store changes
    const projectStore = useProjectStore.getState();
    const threadStore = useThreadStore.getState();
    const uiStore = useUIStore.getState();

    if (settingsPage && validSettingsIds.has(settingsPage as any)) {
      if (!uiStore.settingsOpen) uiStore.setSettingsOpen(true);
      if (uiStore.activeSettingsPage !== settingsPage) uiStore.setActiveSettingsPage(settingsPage);
      if (projectId && projectId !== projectStore.selectedProjectId)
        projectStore.selectProject(projectId);
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
      // Clear search/allThreads when entering inbox
      if (uiStore.allThreadsProjectId) uiStore.closeAllThreads();
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
      // Clear search/allThreads when entering analytics
      if (uiStore.allThreadsProjectId) uiStore.closeAllThreads();
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
      // Clear search/allThreads when entering grid
      if (uiStore.allThreadsProjectId) uiStore.closeAllThreads();
      return;
    }

    // Close live columns when navigating away
    if (uiStore.liveColumnsOpen) {
      uiStore.setLiveColumnsOpen(false);
    }

    // Add project view: /new
    if (addProject) {
      if (!uiStore.addProjectOpen) {
        uiStore.setAddProjectOpen(true);
      }
      return;
    }

    // Close add project when navigating away from /new
    if (uiStore.addProjectOpen) {
      uiStore.setAddProjectOpen(false);
    }

    // List/Kanban view: /list or /kanban (with optional ?project= query param)
    if (globalSearch) {
      // Always ensure search state is active — this handles both fresh navigation
      // and cases where state was cleared by another view
      uiStore.showGlobalSearch();
      // Clear kanban context when arriving at /list so both state changes
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
      if (
        threadId !== threadStore.selectedThreadId ||
        !threadStore.activeThread ||
        threadStore.activeThread.id !== threadId
      ) {
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
      // Root path — clear selection (only if something is selected to avoid no-op state updates)
      if (threadStore.selectedThreadId != null) threadStore.selectThread(null);
      if (projectStore.selectedProjectId != null) projectStore.selectProject(null);
    }
  }, [location.pathname, location.search, initialized]);
}
