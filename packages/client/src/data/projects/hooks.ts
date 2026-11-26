import type { Project } from '@funny/shared';
import { eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';

import { remoteUrlToBrowseUrl } from '@/lib/git-remote-url';

import { useDataLayer, useDataQuery } from '../hooks';
import { liveQueryKey } from '../live-query-key';
import { projectBranchesQuery } from './branches';
import { projectRemoteUrlQuery } from './remote';
import { projectRoleQuery, roleAllows } from './role';
import { compareProjects, getProjectsData } from './store';

/**
 * React read API for projects: live queries over the session's projects
 * collection. Rows are plain `Project`s; unchanged rows keep their reference.
 */

const NO_PROJECTS: Project[] = [];

/** Every project of the session, in list order. */
export function useProjects(): Project[] {
  const data = getProjectsData(useDataLayer());
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('projects:useProjects', data.collection),
    query: (q) => q.from({ project: data.collection }),
  });
  return useMemo(() => {
    if (!rows || rows.length === 0) return NO_PROJECTS;
    return rows.map((row) => data.fromRow(row)).sort(compareProjects(data));
  }, [rows, data]);
}

export function useProjectById(projectId: string | null | undefined): Project | undefined {
  const data = getProjectsData(useDataLayer());
  const id = projectId ?? '';
  const { data: rows } = useLiveQuery({
    queryKey: liveQueryKey('projects:useProjectById', data.collection, id),
    query: (q) => q.from({ project: data.collection }).where(({ project }) => eq(project.id, id)),
  });
  const row = rows?.[0];
  return useMemo(() => (row ? data.fromRow(row) : undefined), [row, data]);
}

/**
 * The project's checked-out branch, from the shared branch listing. Observes
 * the cache only: the listing is fetched where the project is selected or
 * expanded (`project-store.fetchBranch`), so mounting a reader adds no request.
 */
export function useProjectCurrentBranch(projectId: string | null | undefined): string | undefined {
  const { data } = useDataQuery({ ...projectBranchesQuery(projectId ?? ''), enabled: false });
  return projectId ? (data?.currentBranch ?? undefined) : undefined;
}

/**
 * The project's repository on GitHub (`https://github.com/owner/repo`), from
 * its origin remote; `undefined` while it loads, without a remote, or for a
 * remote that is not on GitHub.
 */
export function useProjectGitHubRepoUrl(projectId: string | null | undefined): string | undefined {
  const { data } = useDataQuery({
    ...projectRemoteUrlQuery(projectId ?? ''),
    enabled: !!projectId,
  });
  const browseUrl = data ? remoteUrlToBrowseUrl(data) : null;
  return browseUrl && /^https:\/\/(www\.)?github\.com\//i.test(browseUrl) ? browseUrl : undefined;
}

/**
 * Whether the caller may start threads on the project (`steer`): hides the
 * per-user runtime and factory controls from a viewer, whose saves the server
 * refuses. While the role loads, the controls show (the server still decides).
 */
export function useCanSteerProject(projectId: string): boolean {
  return roleAllows(useDataQuery(projectRoleQuery(projectId)).data, 'steer');
}

/**
 * Whether the caller administers the project (`manage`): enables the controls
 * of what the project's members share, such as its shared secrets. While the
 * role loads, the controls show (the server still decides).
 */
export function useCanManageProject(projectId: string): boolean {
  return roleAllows(useDataQuery(projectRoleQuery(projectId)).data, 'manage');
}
