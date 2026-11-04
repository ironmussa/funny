import { useEffect } from 'react';

import { fetchForThread, fetchProjectStatus } from '@/data/git-status/actions';
import { createClientLogger } from '@/lib/client-logger';
import { useProjectStore } from '@/stores/project-store';
import { useReviewPaneStore } from '@/stores/review-pane-store';
import { useThreadStore } from '@/stores/thread-store';

const log = createClientLogger('refresh-on-focus');

/**
 * Refreshes git state whenever the browser tab/window regains focus. This
 * catches external changes (e.g. `git commit` from a terminal) that the
 * server-side `.git/` watcher misses while no agent is running.
 *
 * Only refreshes the surfaces the user is actually looking at — the active
 * thread and the selected project — to avoid fanning out one request per
 * known project and tripping the server's per-user rate limit.
 */
export function useRefreshOnFocus() {
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;

      const { selectedProjectId } = useProjectStore.getState();
      const { activeThread } = useThreadStore.getState();

      if (selectedProjectId) {
        fetchProjectStatus(selectedProjectId, true);
      }

      if (activeThread?.id) {
        fetchForThread(activeThread.id, true);
        // Triggers useAutoRefreshDiff in ReviewPane to re-fetch the diff.
        useReviewPaneStore.getState().notifyDirty(activeThread.id);
      }

      log.debug('refreshed on focus', {
        selectedProjectId,
        activeThreadId: activeThread?.id,
      });
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
