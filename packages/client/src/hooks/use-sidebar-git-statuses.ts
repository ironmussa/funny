import type { GitStatusInfo, Thread } from '@funny/shared';
import { useMemo } from 'react';

import { useGitStatusMaps } from '@/data/git-status/hooks';
import {
  branchKey as computeBranchKey,
  gitStatusForThreadFromState,
  gitStatusSidebarFingerprint,
} from '@/data/git-status/keys';

export function useSidebarGitStatuses(threads: Thread[]) {
  // Pre-compute branchKeys from thread data so we don't depend on threadToBranchKey
  // (which requires a prior fetch per thread to be populated).
  const threadBranchKeys = useMemo(
    () => new Map(threads.map((t) => [t.id, computeBranchKey(t)])),
    [threads],
  );
  const maps = useGitStatusMaps();
  // Fingerprint only the statuses of threads visible in *this* project, so a
  // change to an unrelated thread's status keeps the returned object stable.
  const { fingerprint, statuses } = useMemo(() => {
    let fp = '';
    for (const [id, fallbackBk] of threadBranchKeys) {
      const st = maps.statusByBranch[maps.threadToBranchKey[id] ?? fallbackBk];
      if (st) fp += `${gitStatusSidebarFingerprint(id, st)},`;
    }
    const result: Record<string, GitStatusInfo> = {};
    for (const thread of threads) {
      const status = gitStatusForThreadFromState(maps, thread);
      if (status) result[thread.id] = status;
    }
    return { fingerprint: fp, statuses: result };
  }, [maps, threads, threadBranchKeys]);

  // Re-derive only when the visible fingerprint changes (or the thread list does).
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-doctor/exhaustive-deps
  return useMemo(() => statuses, [threads, fingerprint]);
}
