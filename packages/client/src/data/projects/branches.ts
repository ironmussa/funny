import { projectsApi } from '@/lib/api/projects';

import type { DataLayer } from '../data-layer';
import { unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';

/**
 * A project's branch listing (`GET /projects/:id/branches`) as one shared
 * `QueryClient` query per project. The sidebar's current-branch label and the
 * new-thread branch picker read the same entry, so they share one request.
 * Freshness replaces the former 10 s branch cooldown map; in-flight
 * de-duplication and the query signal replace its in-flight set and abort
 * controllers.
 */

export interface ProjectBranches {
  branches: string[];
  remoteBranches: string[];
  defaultBranch: string | null;
  currentBranch: string | null;
}

/** Branches change rarely (only on checkout/merge). */
const BRANCHES_STALE_MS = 10_000;

function projectBranchesQuery(projectId: string) {
  return {
    queryKey: ['project-branches', projectId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<ProjectBranches> =>
      unwrapResult(projectsApi.listBranches(projectId, signal)),
    staleTime: BRANCHES_STALE_MS,
  };
}

/**
 * The project's listing, fetched unless fresh (`force` ignores freshness).
 * Resolves to the cached entry, or `undefined` when the request failed or was
 * cancelled by `setProjectCurrentBranch`.
 */
export async function fetchProjectBranches(
  projectId: string,
  { force = false }: { force?: boolean } = {},
  layer: DataLayer = getDataLayer(),
): Promise<ProjectBranches | undefined> {
  const query = projectBranchesQuery(projectId);
  await layer.queryClient
    .fetchQuery(force ? { ...query, staleTime: 0 } : query)
    .catch(() => undefined);
  // Read back from the cache: a checkout that landed mid-flight cancelled the
  // request and wrote the authoritative branch there.
  return layer.queryClient.getQueryData<ProjectBranches>(query.queryKey);
}

/**
 * Record a branch the caller already knows (e.g. it just checked it out).
 * Cancels an in-flight listing, which read the pre-checkout branch, so it
 * cannot overwrite this value.
 */
export function setProjectCurrentBranch(
  projectId: string,
  branch: string,
  layer: DataLayer = getDataLayer(),
): void {
  const { queryKey } = projectBranchesQuery(projectId);
  void layer.queryClient.cancelQueries({ queryKey });
  const cached = layer.queryClient.getQueryData<ProjectBranches>(queryKey);
  if (cached) {
    layer.queryClient.setQueryData<ProjectBranches>(queryKey, {
      ...cached,
      currentBranch: branch,
    });
  }
}
