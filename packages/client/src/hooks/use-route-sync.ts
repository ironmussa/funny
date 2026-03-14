import { useEffect } from 'react';
import { useLocation, useNavigate, matchPath } from 'react-router-dom';
import { toast } from 'sonner';

import { settingsItems } from '@/components/SettingsPanel';
import { authClient } from '@/lib/auth-client';
import { stripOrgPrefix } from '@/lib/url';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore, getSelectingThreadId } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

function parseRoute(pathname: string) {
  // Strip org prefix: /:orgSlug/... → extract slug and clean path
  const [orgSlug, cleanPath] = stripOrgPrefix(pathname);

  // Use cleanPath for all route matching below
  const p = cleanPath;

  // Preferences (general settings): /preferences/:pageId
  const preferencesMatch = matchPath('/preferences/:pageId', p);
  if (preferencesMatch) {
    return {
      orgSlug,
      settingsPage: null,
      preferencesPage: preferencesMatch.params.pageId!,
      projectId: null,
      threadId: null,
      globalSearch: false,
      inbox: false,
      analytics: false,
      liveColumns: false,
      addProject: false,
    };
  }

  // Project-scoped settings: /projects/:projectId/settings/:pageId
  const projectSettingsMatch = matchPath('/projects/:projectId/settings/:pageId', p);
  if (projectSettingsMatch) {
    return {
      orgSlug,
      settingsPage: projectSettingsMatch.params.pageId!,
      preferencesPage: null,
      projectId: projectSettingsMatch.params.projectId!,
      threadId: null,
      globalSearch: false,
      inbox: false,
      analytics: false,
      liveColumns: false,
      addProject: false,
    };
  }

  const settingsMatch = matchPath('/settings/:pageId', p);
  if (settingsMatch) {
    return {
      orgSlug,
      settingsPage: settingsMatch.params.pageId!,
      preferencesPage: null,
      projectId: null,
      threadId: null,
      globalSearch: false,
      inbox: false,
      analytics: false,
      liveColumns: false,
      addProject: false,
    };
  }

  const threadMatch = matchPath('/projects/:projectId/threads/:threadId', p);
  if (threadMatch) {
    return {
      orgSlug,
      settingsPage: null,
      projectId: threadMatch.params.projectId!,
      threadId: threadMatch.params.threadId!,
      preferencesPage: null,
      globalSearch: false,
      inbox: false,
      analytics: false,
      liveColumns: false,
      addProject: false,
    };
  }

  const projectMatch = matchPath('/projects/:projectId', p);
  if (projectMatch) {
    return {
      orgSlug,
      settingsPage: null,
      preferencesPage: null,
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
  if (p === '/inbox') {
    return {
      orgSlug,
      settingsPage: null,
      preferencesPage: null,
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
  if (p === '/list') {
    return {
      orgSlug,
      settingsPage: null,
      preferencesPage: null,
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
  if (p === '/kanban') {
    return {
      orgSlug,
      settingsPage: null,
      preferencesPage: null,
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
  const projectAnalyticsMatch = matchPath('/projects/:projectId/analytics', p);
  if (projectAnalyticsMatch) {
    return {
      orgSlug,
      settingsPage: null,
      preferencesPage: null,
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
  if (p === '/analytics') {
    return {
      orgSlug,
      settingsPage: null,
      preferencesPage: null,
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
  if (p === '/grid') {
    return {
      orgSlug,
      settingsPage: null,
      preferencesPage: null,
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
  if (p === '/new') {
    return {
      orgSlug,
      settingsPage: null,
      preferencesPage: null,
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
    orgSlug,
    settingsPage: null,
    preferencesPage: null,
    projectId: null,
    threadId: null,
    globalSearch: false,
    inbox: false,
    analytics: false,
    liveColumns: false,
    addProject: false,
  };
}

const validSettingsIds = new Set([...settingsItems.map((i) => i.id), 'users', 'team-members']);

export function useRouteSync() {
  const location = useLocation();
  const navigate = useNavigate();
  // Subscribe only to `initialized` from project-store (not the entire app state)
  const initialized = useProjectStore((s) => s.initialized);

  // Sync URL → store whenever location changes (wait for auth + projects first)
  useEffect(() => {
    if (!initialized) return;

    const {
      orgSlug,
      settingsPage,
      preferencesPage,
      projectId,
      threadId,
      globalSearch,
      inbox,
      analytics,
      liveColumns,
      addProject,
    } = parseRoute(location.pathname);

    // --- Org auto-switch ---
    const authState = useAuthStore.getState();
    const currentSlug = authState.activeOrgSlug;

    if (orgSlug && orgSlug !== currentSlug) {
      // URL has an org slug that differs from current — auto-switch
      (async () => {
        try {
          const res = await authClient.organization.list();
          const orgList = res.data ?? [];
          const targetOrg = orgList.find((o: any) => o.slug === orgSlug);
          if (!targetOrg) {
            toast.error(`Organization "${orgSlug}" not found`);
            navigate('/');
            return;
          }
          await authClient.organization.setActive({ organizationId: targetOrg.id });
          useAuthStore.getState().setActiveOrg(targetOrg.id, targetOrg.name, targetOrg.slug);
          // Clear threads and reload projects for the new org
          useThreadStore.setState({
            threadsByProject: {},
            selectedThreadId: null,
            activeThread: null,
          });
          await useProjectStore.getState().loadProjects();
        } catch (err) {
          console.error('[useRouteSync] Failed to auto-switch org:', err);
          toast.error('Failed to switch organization');
          navigate('/');
        }
      })();
    } else if (!orgSlug && currentSlug) {
      // URL has no org slug but we have an active org — switch to personal
      (async () => {
        try {
          await authClient.organization.setActive({ organizationId: null as any });
          useAuthStore.getState().setActiveOrg(null, null, null);
          useThreadStore.setState({
            threadsByProject: {},
            selectedThreadId: null,
            activeThread: null,
          });
          await useProjectStore.getState().loadProjects();
        } catch (err) {
          console.error('[useRouteSync] Failed to switch to personal:', err);
        }
      })();
    }
    // Use imperative getState() to avoid subscribing to store changes
    const projectStore = useProjectStore.getState();
    const threadStore = useThreadStore.getState();
    const uiStore = useUIStore.getState();

    // Preferences (general settings): /preferences/:pageId
    if (preferencesPage) {
      if (!uiStore.generalSettingsOpen) uiStore.setGeneralSettingsOpen(true);
      if (uiStore.activePreferencesPage !== preferencesPage)
        uiStore.setActivePreferencesPage(preferencesPage);
      return;
    }

    // Close preferences if navigating away from /preferences
    if (uiStore.generalSettingsOpen) {
      uiStore.setGeneralSettingsOpen(false);
    }

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
      // Skip if selectThread is already in-flight for this thread (prevents
      // StrictMode double-fire from re-triggering while the first call is loading).
      const alreadyLoading = getSelectingThreadId() === threadId;
      if (
        !alreadyLoading &&
        (threadId !== threadStore.selectedThreadId ||
          !threadStore.activeThread ||
          threadStore.activeThread.id !== threadId)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- navigate is stable from useNavigate
  }, [location.pathname, location.search, initialized, navigate]);
}
