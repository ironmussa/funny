import type { Thread } from '@funny/shared';
import { useMemo } from 'react';

import { normalize } from '@/components/ui/highlight-text';
import type { GitStatusMaps } from '@/data/git-status/keys';
import { statusBranchKeyForThread } from '@/data/git-status/keys';
import { isFactoryThread, isScratch } from '@/lib/thread-variant';

interface ThreadFilterInput {
  allThreads: Thread[];
  search: string;
  caseSensitive: boolean;
  statusFilter: Set<string>;
  gitFilter: Set<string>;
  modeFilter: Set<string>;
  typeFilter: Set<string>;
  originFilter: Set<string>;
  statusByBranch: GitStatusMaps['statusByBranch'];
  threadToBranchKey: GitStatusMaps['threadToBranchKey'];
  projectFilter: string | null;
  projectNameById: Record<string, string>;
  sortField: 'updated' | 'created';
  sortDir: 'desc' | 'asc';
  contentMatches: Map<string, string>;
}

/** Applies the All Threads search, filters and sort to the loaded threads. */
export function filterAndSortThreads({
  allThreads,
  search,
  caseSensitive,
  statusFilter,
  gitFilter,
  modeFilter,
  typeFilter,
  originFilter,
  statusByBranch,
  threadToBranchKey,
  projectFilter,
  projectNameById,
  sortField,
  sortDir,
  contentMatches,
}: ThreadFilterInput): Thread[] {
  let result = allThreads;

  // Text search — matches title, branch, status, project name, OR message content.
  // Case-insensitive by default (also strips accents); case-sensitive uses raw substring match.
  if (search.trim()) {
    const matches = caseSensitive
      ? (text: string | undefined | null) => !!text && text.includes(search)
      : (
          (q) => (text: string | undefined | null) =>
            !!text && normalize(text).includes(q)
        )(normalize(search));
    result = result.filter(
      (t) =>
        matches(t.title) ||
        matches(t.branch) ||
        matches(t.status) ||
        (!projectFilter && matches(projectNameById[t.projectId])) ||
        contentMatches.has(t.id),
    );
  }

  // Status filter (multi-select)
  if (statusFilter.size > 0) {
    result = result.filter((t) => statusFilter.has(t.status));
  }

  // Git status filter (multi-select)
  if (gitFilter.size > 0) {
    result = result.filter((t) => {
      const gs = statusByBranch[statusBranchKeyForThread(t, threadToBranchKey)];
      return gs ? gitFilter.has(gs.state) : false;
    });
  }

  // Mode filter (multi-select)
  if (modeFilter.size > 0) {
    result = result.filter((t) => modeFilter.has(t.mode));
  }

  // Type filter (scratch vs normal)
  if (typeFilter.size > 0) {
    result = result.filter((t) => typeFilter.has(isScratch(t) ? 'scratch' : 'normal'));
  }

  // Origin filter (started by the issue factory vs by a person)
  if (originFilter.size > 0) {
    result = result.filter((t) => originFilter.has(threadOrigin(t)));
  }

  // Sort by selected field and direction
  result = result.toSorted((a, b) => {
    const dateA = sortField === 'updated' ? (a.completedAt ?? a.createdAt) : a.createdAt;
    const dateB = sortField === 'updated' ? (b.completedAt ?? b.createdAt) : b.createdAt;
    const diff = new Date(dateA).getTime() - new Date(dateB).getTime();
    return sortDir === 'desc' ? -diff : diff;
  });

  return result;
}

/** Counts per type, status and git state for the filter dropdowns. */
export function useThreadFilterCounts(
  allThreads: Thread[],
  statusByBranch: GitStatusMaps['statusByBranch'],
  threadToBranchKey: GitStatusMaps['threadToBranchKey'],
) {
  // Counts for type filter (scratch vs normal)
  const typeCounts = useMemo(() => {
    const counts = { scratch: 0, normal: 0 };
    for (const t of allThreads) {
      counts[isScratch(t) ? 'scratch' : 'normal']++;
    }
    return counts;
  }, [allThreads]);

  // Counts for the origin filter (factory, automation, user)
  const originCounts = useMemo(() => {
    const counts = { factory: 0, automation: 0, user: 0 };
    for (const t of allThreads) counts[threadOrigin(t)]++;
    return counts;
  }, [allThreads]);

  // Compute counts for status filters
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of allThreads) {
      counts[t.status] = (counts[t.status] || 0) + 1;
    }
    return counts;
  }, [allThreads]);

  // Compute counts for git status filters
  const gitCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of allThreads) {
      const gs = statusByBranch[statusBranchKeyForThread(t, threadToBranchKey)];
      if (gs) {
        counts[gs.state] = (counts[gs.state] || 0) + 1;
      }
    }
    return counts;
  }, [allThreads, statusByBranch, threadToBranchKey]);

  return { typeCounts, originCounts, statusCounts, gitCounts };
}

/** Who started a thread, as the origin filter names it. */
function threadOrigin(thread: Thread): 'factory' | 'automation' | 'user' {
  if (isFactoryThread(thread)) return 'factory';
  return thread.automationId ? 'automation' : 'user';
}
