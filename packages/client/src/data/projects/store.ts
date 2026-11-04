import type { Project } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { createEntityStore, type EntityStore } from '../entities';
import { getDataLayer } from '../runtime';

/**
 * The session's projects: one collection row per project, in the order the
 * server lists them. The order is `sortOrder`, then the position in the last
 * list response (the server concatenates owned and shared projects), so a
 * reorder only has to rewrite `sortOrder`.
 */
export interface ProjectsData extends EntityStore<Project> {
  /** Position of each project in the last list response (sort tie-breaker). */
  readonly listIndex: Map<string, number>;
  /** Whether a list response has landed in this session. */
  loaded: boolean;
}

function createProjectsData(layer: DataLayer): ProjectsData {
  return Object.assign(createEntityStore<Project>(layer, 'projects'), {
    listIndex: new Map<string, number>(),
    loaded: false,
  });
}

export function getProjectsData(layer: DataLayer = getDataLayer()): ProjectsData {
  return layer.own('projects', () => {
    const data = createProjectsData(layer);
    return {
      value: data,
      dispose: () => void data.collection.cleanup({ dependents: true }).catch(() => undefined),
    };
  });
}

/** Server list order: `sortOrder`, then the position in the last list response. */
export function compareProjects(data: ProjectsData) {
  const index = (p: Project) => data.listIndex.get(p.id) ?? Number.MAX_SAFE_INTEGER;
  return (a: Project, b: Project) => a.sortOrder - b.sortOrder || index(a) - index(b);
}
