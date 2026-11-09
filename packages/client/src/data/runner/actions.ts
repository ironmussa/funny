import type { DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import i18n from '@/i18n/config';
import {
  infraApi,
  type ProjectSandboxSettings,
  type SaveProjectSandboxInput,
} from '@/lib/api/infra';
import { createClientLogger } from '@/lib/client-logger';
import { metric } from '@/lib/telemetry';
import { clientComposition } from '@/platform/client-composition';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { projectSandboxQuery, setProjectSandbox } from './queries';

/**
 * Project sandbox writes (change project-sandboxes): the change shows at once,
 * the server's answer replaces it, and a refusal restores the previous value
 * with a toast.
 */

const log = createClientLogger('project-sandbox');

function notifyFailure(operation: string, error: DomainError): void {
  metric('data.project_sandbox.write_failed', 1, { attributes: { operation, type: error.type } });
  log.warn('project sandbox write failed', { operation, error: error.message });
  clientComposition.platform.effects.emit({
    type: 'toast',
    level: 'error',
    message: i18n.t('errors.projectSandboxUpdateFailed', 'Could not update the project sandbox'),
    description: error.friendlyMessage ?? error.message,
  });
}

function write<R>(
  projectId: string,
  operation: string,
  optimistic: ProjectSandboxSettings | null,
  persist: () => ResultAsync<R, DomainError>,
  confirmed: (value: R) => ProjectSandboxSettings | null,
  layer: DataLayer,
): ResultAsync<ProjectSandboxSettings | null, DomainError> {
  const { queryKey } = projectSandboxQuery(projectId);
  void layer.queryClient.cancelQueries({ queryKey });
  const previous = layer.queryClient.getQueryData<ProjectSandboxSettings | null>(queryKey);
  setProjectSandbox(projectId, optimistic, layer);
  return persist()
    .map((value) => {
      const settings = confirmed(value);
      setProjectSandbox(projectId, settings, layer);
      return settings;
    })
    .mapErr((error) => {
      setProjectSandbox(projectId, previous ?? null, layer);
      notifyFailure(operation, error);
      return error;
    });
}

/** Set the current user's sandbox for a project. */
export function saveProjectSandbox(
  projectId: string,
  input: SaveProjectSandboxInput,
  layer: DataLayer = getDataLayer(),
): ResultAsync<ProjectSandboxSettings | null, DomainError> {
  const optimistic: ProjectSandboxSettings = {
    projectId,
    connectionId: input.connectionId,
    sizeId: input.sizeId ?? '',
    enabledByDefault: input.enabledByDefault,
    updatedAt: new Date().toISOString(),
  };
  return write(
    projectId,
    'save',
    optimistic,
    () => infraApi.saveProjectSandbox(projectId, input),
    (r) => r.settings,
    layer,
  );
}

/** Clear the current user's sandbox for a project. */
export function clearProjectSandbox(
  projectId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<ProjectSandboxSettings | null, DomainError> {
  return write(
    projectId,
    'clear',
    null,
    () => infraApi.clearProjectSandbox(projectId),
    () => null,
    layer,
  );
}
