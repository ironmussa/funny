import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import { stripOrgPrefix } from '@/lib/url';
import { useThreadHistoryStore } from '@/stores/thread-history-store';

const THREAD_ROUTE = /^\/projects\/([^/]+)\/threads\/([^/]+)/;
const SCRATCH_ROUTE = /^\/scratch\/([^/]+)/;

/**
 * Pushes the current thread into the thread-history stack whenever the
 * location resolves to a project-thread or scratch-thread route. Entries
 * matching the current head are a no-op, so Alt+Left/Right navigations
 * (which mutate `past`/`future` to already match the target) don't get
 * re-pushed.
 */
export function useThreadHistoryTracker() {
  const location = useLocation();

  useEffect(() => {
    const [, cleanPath] = stripOrgPrefix(location.pathname);
    const projectMatch = cleanPath.match(THREAD_ROUTE);
    if (projectMatch) {
      const [, projectId, threadId] = projectMatch;
      useThreadHistoryStore.getState().pushThread({ projectId, threadId });
      return;
    }
    const scratchMatch = cleanPath.match(SCRATCH_ROUTE);
    if (scratchMatch) {
      const [, threadId] = scratchMatch;
      if (threadId === 'new') return;
      useThreadHistoryStore.getState().pushThread({
        projectId: '',
        threadId,
        isScratch: true,
      });
    }
  }, [location.pathname]);
}
