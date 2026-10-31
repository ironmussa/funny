import type { Thread } from '@funny/shared';
import { useMemo, useCallback } from 'react';

import {
  useGitStatusStore,
  branchKey as computeBranchKey,
  gitStatusForThreadFromState,
  gitStatusSidebarFingerprint,
} from '@/stores/git-status-store';

const getGitStatusState = useGitStatusStore.getState;

export function useSidebarGitStatuses(threads: Thread[]) {
  // Pre-compute branchKeys from thread data so we don't depend on threadToBranchKey
  // (which requires a prior fetch per thread to be populated).
  const threadBranchKeys = useMemo(
    () => new Map(threads.map((t) => [t.id, computeBranchKey(t)])),
    [threads],
  );
  // Select only the git statuses for threads visible in *this* project.
  // The selector returns a fingerprint string so Zustand's Object.is check
  // skips re-renders when unrelated threads' git statuses change.
  const gitStatusFingerprint = useGitStatusStore(
    useCallback(
      (s: {
        statusByBranch: Record<string, import('@funny/shared').GitStatusInfo>;
        threadToBranchKey: Record<string, string>;
      }) => {
        let fp = '';
        for (const [id, fallbackBk] of threadBranchKeys) {
          const bk = s.threadToBranchKey[id] ?? fallbackBk;
          const st = s.statusByBranch[bk];
          if (st) fp += `${gitStatusSidebarFingerprint(id, st)},`;
        }
        return fp;
      },
      [threadBranchKeys],
    ),
  );
  // Derive the actual status objects only when the fingerprint changes
  const gitStatusForThreads = useMemo(() => {
    const state = getGitStatusState();
    const result: Record<string, import('@funny/shared').GitStatusInfo> = {};
    for (const thread of threads) {
      const status = gitStatusForThreadFromState(state, thread);
      if (status) result[thread.id] = status;
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-doctor/exhaustive-deps
  }, [threads, threadBranchKeys, gitStatusFingerprint]);

  return gitStatusForThreads;
}
