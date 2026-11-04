import { useEffect, useId } from 'react';

import { fetchForProject, ensureStatusForThreads } from '@/data/git-status/actions';
import {
  setGitStatusScope,
  clearGitStatusScope,
  type GitStatusScope,
} from '@/data/git-status/store';

/**
 * Declare which threads this mounted view needs git status for, so the bulk
 * `/git/status` fetch only computes those (see `setGitStatusScope`).
 *
 * - `threads`: the thread rows the view renders; grouped by project.
 * - `'all'` + `projectIds`: the view needs every thread of those projects
 *   (filters/sorts by git state, e.g. All threads or Kanban). Registering
 *   also requests those projects, since an earlier scoped fetch may have
 *   covered only the sidebar rows (the widened scope bypasses the cooldown).
 *
 * The registration is replaced on change and dropped on unmount. Call it
 * BEFORE the effect that triggers the fetch (`ensureStatusForThreads`) so the
 * scope is in place when the request is built.
 */
export function useGitStatusScope(
  input:
    | { threads: ReadonlyArray<{ id: string; projectId?: string | null }> }
    | { all: true; projectIds: ReadonlyArray<string> },
): void {
  const consumerId = useId();
  const scopeKey = scopeKeyFor(input);

  useEffect(() => {
    const scope: GitStatusScope = Object.fromEntries(JSON.parse(scopeKey));
    setGitStatusScope(consumerId, scope);
    for (const [projectId, entry] of Object.entries(scope)) {
      if (entry === 'all') void fetchForProject(projectId);
    }
  }, [consumerId, scopeKey]);

  useEffect(() => () => clearGitStatusScope(consumerId), [consumerId]);
}

type ScopeInput = Parameters<typeof useGitStatusScope>[0];

/** Stable, content-based key: `[[projectId, ids | 'all'], ...]` sorted. */
function scopeKeyFor(input: ScopeInput): string {
  if ('all' in input) return JSON.stringify([...input.projectIds].sort().map((p) => [p, 'all']));
  const byProject = new Map<string, string[]>();
  for (const t of input.threads) {
    if (!t.projectId) continue;
    const ids = byProject.get(t.projectId) ?? [];
    ids.push(t.id);
    byProject.set(t.projectId, ids);
  }
  return JSON.stringify(
    [...byProject.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, ids]) => [p, ids.sort()]),
  );
}

/** Register before fetching, and stop requesting rows when the view is hidden. */
export function useVisibleGitStatus(
  threads: Parameters<typeof ensureStatusForThreads>[0],
  visible = true,
) {
  useGitStatusScope({ threads: visible ? threads : [] });
  useEffect(() => {
    if (visible) ensureStatusForThreads(threads);
  }, [threads, visible]);
}
