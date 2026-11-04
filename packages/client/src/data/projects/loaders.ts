import type { Project } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { projectsApi } from '@/lib/api/projects';

import type { DataLayer } from '../data-layer';
import { layerRequestSignal } from '../data-layer';
import { toDomainError, unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';
import { getProjectsData } from './store';

export interface ProjectListScope {
  /** Active organization; its projects are all the list contains. */
  orgId: string | null;
  orgName?: string | null;
}

/** Org projects are badged as team projects with the org's name. */
function decorate(projects: Project[], scope: ProjectListScope): Project[] {
  if (!scope.orgId) return projects;
  return projects.map((p) => ({
    ...p,
    isTeamProject: true as const,
    organizationName: p.organizationName || scope.orgName || undefined,
  }));
}

/**
 * Load the session's project list and make it the complete synced set.
 * Concurrent loads share one request (query-core de-duplicates in flight).
 */
export function loadProjects(
  scope: ProjectListScope,
  layer: DataLayer = getDataLayer(),
): ResultAsync<Project[], DomainError> {
  const data = getProjectsData(layer);
  return ResultAsync.fromPromise(
    layer.queryClient.fetchQuery({
      queryKey: ['projects', scope.orgId],
      staleTime: 0,
      queryFn: async ({ signal }) => {
        const projects = await unwrapResult(
          projectsApi.listProjects(scope.orgId, undefined, layerRequestSignal(layer, signal)),
        );
        const rows = decorate(projects, scope);
        data.listIndex.clear();
        rows.forEach((p, i) => data.listIndex.set(p.id, i));
        data.replaceAll(rows);
        data.loaded = true;
        return rows;
      },
    }),
    toDomainError,
  );
}

/**
 * Add or refresh projects the server returned outside a list load (search
 * results, a newly created project). They join the end of the list until the
 * next load puts them in server order.
 */
export function upsertProjects(
  projects: readonly Project[],
  layer: DataLayer = getDataLayer(),
): void {
  const data = getProjectsData(layer);
  for (const project of projects) {
    if (!data.listIndex.has(project.id)) data.listIndex.set(project.id, data.listIndex.size);
  }
  data.upsert(projects);
}
