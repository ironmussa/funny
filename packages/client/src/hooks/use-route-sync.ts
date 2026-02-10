import { useEffect } from 'react';
import { useLocation, matchPath } from 'react-router-dom';
import { useAppStore } from '@/stores/app-store';
import { settingsItems } from '@/components/SettingsPanel';

function parseRoute(pathname: string) {
  // Project-scoped settings: /projects/:projectId/settings/:pageId
  const projectSettingsMatch = matchPath('/projects/:projectId/settings/:pageId', pathname);
  if (projectSettingsMatch) {
    return {
      settingsPage: projectSettingsMatch.params.pageId!,
      projectId: projectSettingsMatch.params.projectId!,
      threadId: null,
      allThreads: false,
    };
  }

  const settingsMatch = matchPath('/settings/:pageId', pathname);
  if (settingsMatch) {
    return {
      settingsPage: settingsMatch.params.pageId!,
      projectId: null,
      threadId: null,
      allThreads: false,
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
      allThreads: false,
    };
  }

  // Match /projects/:projectId/threads (all threads view, no specific thread)
  const allThreadsMatch = matchPath('/projects/:projectId/threads', pathname);
  if (allThreadsMatch) {
    return {
      settingsPage: null,
      projectId: allThreadsMatch.params.projectId!,
      threadId: null,
      allThreads: true,
    };
  }

  const projectMatch = matchPath('/projects/:projectId', pathname);
  if (projectMatch) {
    return {
      settingsPage: null,
      projectId: projectMatch.params.projectId!,
      threadId: null,
      allThreads: false,
    };
  }

  return { settingsPage: null, projectId: null, threadId: null, allThreads: false };
}

const validSettingsIds = new Set(settingsItems.map((i) => i.id));

export function useRouteSync() {
  const location = useLocation();
  const initialized = useAppStore(s => s.initialized);

  // Sync URL → store whenever location changes (wait for auth + projects first)
  useEffect(() => {
    if (!initialized) return;

    const { settingsPage, projectId, threadId, allThreads } = parseRoute(location.pathname);
    const store = useAppStore.getState();

    if (settingsPage && validSettingsIds.has(settingsPage as any)) {
      if (!store.settingsOpen) store.setSettingsOpen(true);
      if (store.activeSettingsPage !== settingsPage) store.setActiveSettingsPage(settingsPage);
      if (projectId && projectId !== store.selectedProjectId) store.selectProject(projectId);
      return;
    }

    // Close settings if navigating away from /settings
    if (store.settingsOpen) {
      store.setSettingsOpen(false);
    }

    // Close automation inbox when navigating via URL
    if (store.automationInboxOpen) {
      store.setAutomationInboxOpen(false);
    }

    if (allThreads && projectId) {
      if (store.allThreadsProjectId !== projectId) {
        store.showAllThreads(projectId);
      }
      return;
    }

    // Clear all-threads view if navigating away
    if (store.allThreadsProjectId) {
      store.closeAllThreads();
    }

    if (threadId) {
      // Re-select if the thread ID changed, or if the thread ID matches but
      // activeThread failed to load (e.g. due to a race condition or API error).
      if (threadId !== store.selectedThreadId || !store.activeThread || store.activeThread.id !== threadId) {
        store.selectThread(threadId);
      }
      if (projectId && projectId !== store.selectedProjectId) {
        store.selectProject(projectId);
      }
    } else if (projectId) {
      if (store.selectedThreadId) {
        store.selectThread(null);
      }
      if (projectId !== store.selectedProjectId) {
        store.selectProject(projectId);
      }
    } else {
      // Root path — clear selection
      if (store.selectedThreadId) store.selectThread(null);
      if (store.selectedProjectId) store.selectProject(null);
    }
  }, [location.pathname, initialized]);
}
