import type { Project } from '@funny/shared';
import { eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { useMemo } from 'react';

import { useDataLayer } from '../hooks';
import { compareProjects, getProjectsData } from './store';

/**
 * React read API for projects: live queries over the session's projects
 * collection. Rows are plain `Project`s; unchanged rows keep their reference.
 */

const NO_PROJECTS: Project[] = [];

/** Every project of the session, in list order. */
export function useProjects(): Project[] {
  const data = getProjectsData(useDataLayer());
  const { data: rows } = useLiveQuery((q) => q.from({ project: data.collection }));
  return useMemo(() => {
    if (!rows || rows.length === 0) return NO_PROJECTS;
    return rows.map((row) => data.fromRow(row as Project)).sort(compareProjects(data));
  }, [rows, data]);
}

export function useProjectById(projectId: string | null | undefined): Project | undefined {
  const data = getProjectsData(useDataLayer());
  const id = projectId ?? '';
  const { data: rows } = useLiveQuery((q) =>
    q.from({ project: data.collection }).where(({ project }) => eq(project.id, id)),
  );
  const row = rows?.[0] as Project | undefined;
  return useMemo(() => (row ? data.fromRow(row) : undefined), [row, data]);
}
