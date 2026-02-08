import { useEffect } from 'react';
import { useLocation, matchPath } from 'react-router-dom';
import { useAppStore } from '@/stores/app-store';

function parseRoute(pathname: string) {
  const threadMatch = matchPath(
    '/projects/:projectId/threads/:threadId',
    pathname
  );
  if (threadMatch) {
    return {
      projectId: threadMatch.params.projectId!,
      threadId: threadMatch.params.threadId!,
    };
  }

  const projectMatch = matchPath('/projects/:projectId', pathname);
  if (projectMatch) {
    return {
      projectId: projectMatch.params.projectId!,
      threadId: null,
    };
  }

  return { projectId: null, threadId: null };
}

export function useRouteSync() {
  const location = useLocation();

  // Sync URL → store whenever location changes
  useEffect(() => {
    const { projectId, threadId } = parseRoute(location.pathname);
    const store = useAppStore.getState();

    if (threadId) {
      if (threadId !== store.selectedThreadId) {
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
  }, [location.pathname]);
}
