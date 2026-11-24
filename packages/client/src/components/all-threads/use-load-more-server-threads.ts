import type { Project } from '@funny/shared';
import { useCallback, useMemo, useState } from 'react';

import { useProjectListTotals } from '@/data/threads/hooks';
import { useThreadsByProject } from '@/lib/thread-selectors';
import { whilePending } from '@/lib/while-pending';
import type { ThreadState } from '@/stores/thread-state';

interface LoadMoreInput {
  scratchOnlyFilter: boolean;
  projectFilter: string | null;
  projects: Project[];
  threadsByProject: ReturnType<typeof useThreadsByProject>;
  totalsByProject: ReturnType<typeof useProjectListTotals>;
  loadMoreThreads: ThreadState['loadMoreThreads'];
  showArchived: boolean;
}

/** Whether any relevant project has more threads on the server, and loading them. */
export function useLoadMoreServerThreads({
  scratchOnlyFilter,
  projectFilter,
  projects,
  threadsByProject,
  totalsByProject,
  loadMoreThreads,
  showArchived,
}: LoadMoreInput) {
  const hasMoreServerThreads = useMemo(() => {
    if (scratchOnlyFilter) return false;
    const relevantProjects = projectFilter ? [projectFilter] : projects.map((p) => p.id);
    return relevantProjects.some((pid) => {
      const loaded = (threadsByProject[pid] ?? []).length;
      const total = totalsByProject[pid] ?? 0;
      return loaded < total;
    });
  }, [threadsByProject, totalsByProject, projectFilter, projects, scratchOnlyFilter]);

  const [loadingMore, setLoadingMore] = useState(false);
  const handleLoadMore = useCallback(async () => {
    await whilePending(setLoadingMore, async () => {
      const relevantProjects = projectFilter ? [projectFilter] : projects.map((p) => p.id);
      await Promise.all(
        relevantProjects.flatMap((projectId) =>
          (threadsByProject[projectId] ?? []).length < (totalsByProject[projectId] ?? 0)
            ? [loadMoreThreads(projectId, showArchived)]
            : [],
        ),
      );
    });
  }, [projectFilter, projects, threadsByProject, totalsByProject, loadMoreThreads, showArchived]);

  return { hasMoreServerThreads, loadingMore, handleLoadMore };
}
