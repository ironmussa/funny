import type { Project } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { getProjectsData } from './store';

/**
 * Seeding helpers for tests and stories. Fixtures written in the shape of the
 * former Zustand field (`projects: Project[]`) land in the projects
 * collection, the only place project rows live.
 */

/** Make `projects` the session's complete project list, in this order. */
export function seedProjects(
  projects: readonly Project[],
  layer: DataLayer = getDataLayer(),
): void {
  const data = getProjectsData(layer);
  data.listIndex.clear();
  projects.forEach((p, i) => data.listIndex.set(p.id, i));
  data.replaceAll(projects);
  data.loaded = true;
}

/**
 * Seed the `projects` field of a store patch and return the rest, so a legacy
 * fixture keeps its shape: `useProjectStore.setState(withProjects({ projects, selectedProjectId }))`.
 */
export function withProjects<T extends object>(patch: T): Omit<NoInfer<T>, 'projects'> {
  const { projects, ...rest } = patch as T & { projects?: Project[] };
  if (projects) seedProjects(projects);
  return rest as Omit<T, 'projects'>;
}

/** Seed one sample project (`proj-1`, "funny") and select it — the usual story setup. */
export function withSampleProject(): { selectedProjectId: string } {
  seedProjects([
    {
      id: 'proj-1',
      name: 'funny',
      path: '/home/user/projects/funny',
      userId: 'user-1',
      sortOrder: 0,
      createdAt: new Date().toISOString(),
    },
  ]);
  return { selectedProjectId: 'proj-1' };
}
