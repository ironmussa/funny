import type { GitStatusInfo } from '@funny/shared';
import { eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';

import { useDataLayer } from '../hooks';
import { liveQueryKey } from '../live-query-key';
import { readThreadRow } from '../threads/read';
import { branchKey, type GitStatusMaps, type ProjectGitStatus } from './keys';
import { withoutId } from './read';
import { getGitStatusData, type StatusRow, type ThreadKeyRow } from './store';

/** React reads of git status (live queries over the git-status collections). */

/** Every status by branch key and the thread → branch key mapping, for list views. */
export function useGitStatusMaps(): GitStatusMaps {
  const data = getGitStatusData(useDataLayer());
  const { data: statusRows } = useLiveQuery({
    queryKey: liveQueryKey('git-status:useGitStatusMaps', data.statuses.collection),
    query: (q) => q.from({ s: data.statuses.collection }),
  });
  const { data: keyRows } = useLiveQuery({
    queryKey: liveQueryKey('git-status:useGitStatusMaps', data.threadKeys.collection),
    query: (q) => q.from({ k: data.threadKeys.collection }),
  });
  const statusByBranch = useMemo(() => {
    const out: Record<string, GitStatusInfo> = {};
    for (const row of statusRows ?? []) {
      const plain = data.statuses.fromRow(row as StatusRow);
      out[plain.id] = withoutId(plain) as GitStatusInfo;
    }
    return out;
  }, [statusRows, data]);
  const threadToBranchKey = useMemo(() => {
    const out: Record<string, string> = {};
    for (const row of keyRows ?? [])
      out[(row as ThreadKeyRow).id] = (row as ThreadKeyRow).branchKey;
    return out;
  }, [keyRows]);
  return useMemo(
    () => ({ statusByBranch, threadToBranchKey }),
    [statusByBranch, threadToBranchKey],
  );
}

/**
 * Git status of one thread: threadId → branch key (the server's mapping, else
 * computed from the thread row, so a sibling on the same branch shows cached
 * status before its own request) → status.
 */
export function useGitStatusForThread(threadId: string | undefined): GitStatusInfo | undefined {
  const layer = useDataLayer();
  const data = getGitStatusData(layer);
  const tid = threadId ?? '';
  const { data: keyRows } = useLiveQuery({
    queryKey: liveQueryKey('git-status:useGitStatusForThread', data.threadKeys.collection, tid),
    query: (q) => q.from({ k: data.threadKeys.collection }).where(({ k }) => eq(k.id, tid)),
  });
  const mapped = (keyRows?.[0] as ThreadKeyRow | undefined)?.branchKey;
  const row = threadId ? readThreadRow(threadId, layer) : undefined;
  const bk = mapped ?? (row ? branchKey(row) : '');
  const { data: statusRows } = useLiveQuery({
    queryKey: liveQueryKey('git-status:useGitStatusForThread', data.statuses.collection, bk),
    query: (q) => q.from({ s: data.statuses.collection }).where(({ s }) => eq(s.id, bk)),
  });
  const status = statusRows?.[0] as StatusRow | undefined;
  return useMemo(
    () => (status ? (withoutId(data.statuses.fromRow(status)) as GitStatusInfo) : undefined),
    [status, data],
  );
}

/** Git status of a project root. */
export function useProjectGitStatus(
  projectId: string | null | undefined,
): ProjectGitStatus | undefined {
  const data = getGitStatusData(useDataLayer());
  const id = projectId ?? '';
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('git-status:useProjectGitStatus', data.projects.collection, id),
    query: (q) => q.from({ p: data.projects.collection }).where(({ p }) => eq(p.id, id)),
  });
  const row = rows?.[0];
  return useMemo(() => (row ? withoutId(data.projects.fromRow(row)) : undefined), [row, data]);
}
