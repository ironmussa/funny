import { useCallback } from 'react';

import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { buildPath } from '@/lib/url';
import { useUIStore } from '@/stores/ui-store';

/**
 * Opens the new-thread composer for a project with `branch` preselected as the
 * base branch. Navigates to the project route too: from a thread's URL the
 * route sync would otherwise re-select that thread and drop the composer.
 */
export function useStartThreadOnBranch(): (projectId: string, branch: string) => void {
  const navigate = useStableNavigate();
  const startNewThread = useUIStore((s) => s.startNewThread);
  return useCallback(
    (projectId: string, branch: string) => {
      startNewThread(projectId, false, branch);
      navigate(buildPath(`/projects/${projectId}`));
    },
    [navigate, startNewThread],
  );
}
