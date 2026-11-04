import type { GitStatusInfo } from '@funny/shared';
import { useEffect } from 'react';

import { fetchForThread, fetchProjectStatus } from '@/data/git-status/actions';
import { useGitStatusForThread, useProjectGitStatus } from '@/data/git-status/hooks';
import type { ProjectGitStatus } from '@/data/git-status/keys';

export interface WorkingTreeStatus {
  /** Latest known status for the thread/project working tree (undefined until fetched). */
  status: GitStatusInfo | ProjectGitStatus | undefined;
  /** True when the working tree has uncommitted changes worth surfacing. */
  dirty: boolean;
}

/**
 * Reactively read the working-tree git status for the active thread (or project,
 * in project mode) and keep it fresh while `enabled`. Powers the graph's WIP node;
 * the `dirty` predicate mirrors {@link ThreadPowerline}'s DiffStats visibility so
 * the "has changes" signal is identical across the app.
 */
export function useWorkingTreeStatus(
  effectiveThreadId: string | undefined,
  projectModeId: string | null,
  enabled: boolean,
): WorkingTreeStatus {
  const threadStatus = useGitStatusForThread(effectiveThreadId);
  const projectStatus = useProjectGitStatus(effectiveThreadId ? null : projectModeId);
  const status = effectiveThreadId ? threadStatus : projectStatus;

  // Reuses a fresh status (query freshness), so this is safe to fire on every reveal.
  useEffect(() => {
    if (!enabled) return;
    if (effectiveThreadId) fetchForThread(effectiveThreadId);
    else if (projectModeId) fetchProjectStatus(projectModeId);
  }, [enabled, effectiveThreadId, projectModeId]);

  const dirty =
    !!status &&
    status.state !== 'clean' &&
    (status.linesAdded > 0 || status.linesDeleted > 0 || (status.dirtyFileCount ?? 0) > 0);

  return { status, dirty };
}
