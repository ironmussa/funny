import type { Project } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { errAsync, type ResultAsync } from 'neverthrow';

import { projectsApi, type UpdateProjectInput } from '@/lib/api/projects';

import type { DataLayer } from '../data-layer';
import { optimisticWrite } from '../optimistic-write';
import { getDataLayer } from '../runtime';
import { getProjectsData, type ProjectsData } from './store';

/**
 * Optimistic project writes (`optimistic-write.ts`): the change shows in the
 * same tick in every view and rolls back with a toast if the server refuses.
 */

const FAILURE_KEY = 'errors.projectUpdateFailed';

function missing(projectId: string): ResultAsync<never, DomainError> {
  return errAsync({ type: 'NOT_FOUND', message: `Project ${projectId} is not loaded` });
}

/** The server's project, keeping the client-side org badge it does not send back. */
function withListDecoration(data: ProjectsData, project: Project): Project {
  const prev = data.getSynced(project.id);
  if (!prev?.isTeamProject) return project;
  return {
    ...project,
    isTeamProject: true,
    organizationName: project.organizationName ?? prev.organizationName,
  };
}

/** Apply `fields` optimistically; `persist` answers with the updated project. */
function writeFields(
  projectId: string,
  fields: UpdateProjectInput,
  operation: string,
  persist: () => ResultAsync<Project, DomainError>,
  layer: DataLayer,
): ResultAsync<Project, DomainError> {
  const data = getProjectsData(layer);
  if (!data.collection.has(projectId)) return missing(projectId);
  return optimisticWrite({
    entity: 'projects',
    operation,
    apply: () =>
      data.collection.update(projectId, (draft) => {
        Object.assign(draft, fields);
      }),
    persist,
    confirm: (project) => data.upsert([withListDecoration(data, project)]),
    failureMessageKey: FAILURE_KEY,
  });
}

/** Patch fields of one project. */
export function updateProject(
  projectId: string,
  fields: UpdateProjectInput,
  layer: DataLayer = getDataLayer(),
  operation = 'update',
): ResultAsync<Project, DomainError> {
  return writeFields(
    projectId,
    fields,
    operation,
    () => projectsApi.updateProject(projectId, fields),
    layer,
  );
}

export function renameProject(
  projectId: string,
  name: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<Project, DomainError> {
  return writeFields(
    projectId,
    { name },
    'rename',
    () => projectsApi.renameProject(projectId, name),
    layer,
  );
}

export function closeProject(projectId: string, layer?: DataLayer) {
  return updateProject(projectId, { closed: true }, layer, 'close');
}

export function reopenProject(projectId: string, layer?: DataLayer) {
  return updateProject(projectId, { closed: false }, layer, 'reopen');
}

export function deleteProject(
  projectId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown, DomainError> {
  const data = getProjectsData(layer);
  if (!data.collection.has(projectId)) return missing(projectId);
  return optimisticWrite({
    entity: 'projects',
    operation: 'delete',
    apply: () => data.collection.delete(projectId),
    persist: () => projectsApi.deleteProject(projectId),
    confirm: () => data.remove([projectId]),
    failureMessageKey: FAILURE_KEY,
  });
}

/** Reorder the list: `projectIds` in their new order, each getting `sortOrder` = position. */
export function reorderProjects(
  projectIds: readonly string[],
  layer: DataLayer = getDataLayer(),
): ResultAsync<void, DomainError> {
  const data = getProjectsData(layer);
  const ids = projectIds.filter((id) => data.collection.has(id));
  const setOrder = (row: Project, index: number): Project =>
    row.sortOrder === index ? row : { ...row, sortOrder: index };
  return optimisticWrite({
    entity: 'projects',
    operation: 'reorder',
    apply: () => {
      ids.forEach((id, index) =>
        data.collection.update(id, (draft) => {
          draft.sortOrder = index;
        }),
      );
    },
    persist: () => projectsApi.reorderProjects([...projectIds]),
    confirm: () => {
      ids.forEach((id, index) => data.patch(id, (row) => setOrder(row, index)));
    },
    failureMessageKey: FAILURE_KEY,
  });
}

/** Set a shared project's per-user local path (clears its setup prompt). */
export function setProjectLocalPath(
  projectId: string,
  localPath: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown, DomainError> {
  const data = getProjectsData(layer);
  if (!data.collection.has(projectId)) return missing(projectId);
  const fields = { localPath, needsSetup: false };
  return optimisticWrite({
    entity: 'projects',
    operation: 'local-path',
    apply: () =>
      data.collection.update(projectId, (draft) => {
        Object.assign(draft, fields);
      }),
    persist: () => projectsApi.setProjectLocalPath(projectId, localPath),
    confirm: () => data.patch(projectId, (row) => ({ ...row, ...fields })),
    failureMessageKey: FAILURE_KEY,
  });
}
