import type { Project } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { compareProjects, getProjectsData, type ProjectsData } from './store';

/**
 * Imperative (non-React) reads of the project list, for store actions, event
 * handlers and effect callbacks. React components use `hooks.ts`.
 */

interface CachedList {
  list: Project[] | null;
}

const cachedLists = new WeakMap<ProjectsData, CachedList>();

function cacheFor(data: ProjectsData): CachedList {
  let cache = cachedLists.get(data);
  if (!cache) {
    const created: CachedList = { list: null };
    // Lives as long as the collection; the layer's dispose() cleans both up.
    data.collection.subscribeChanges(
      () => {
        created.list = null;
      },
      { includeInitialState: true },
    );
    cachedLists.set(data, created);
    cache = created;
  }
  return cache;
}

/** The visible projects (optimistic overlays included), in list order. Cached until a change. */
export function readProjects(layer: DataLayer = getDataLayer()): Project[] {
  const data = getProjectsData(layer);
  const cache = cacheFor(data);
  if (!cache.list) {
    const rows = [...data.collection.values()].map((row) => data.fromRow(row));
    cache.list = rows.sort(compareProjects(data));
  }
  return cache.list;
}

export function readProject(
  projectId: string | null | undefined,
  layer: DataLayer = getDataLayer(),
): Project | undefined {
  return projectId ? getProjectsData(layer).read(projectId) : undefined;
}
