import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import {
  projectSecretsApi,
  type ProjectSecretSummary,
  type SetProjectSecretInput,
} from '@/lib/api/project-secrets';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { refreshProjectSecrets } from './queries';

/**
 * Create a secret, or change the one with this name and scope. Not optimistic:
 * the server may refuse the name (reserved) or the caller's role, and a secret
 * must not show as saved before it is. The list is re-read on success; the
 * caller shows the error.
 */
export function setProjectSecret(
  data: SetProjectSecretInput,
  layer: DataLayer = getDataLayer(),
): ResultAsync<ProjectSecretSummary, DomainError> {
  return projectSecretsApi.setProjectSecret(data).map((secret) => {
    refreshProjectSecrets(data.projectId, layer);
    return secret;
  });
}

/** Delete a secret; the list is re-read on success. */
export function deleteProjectSecret(
  projectId: string,
  id: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<void, DomainError> {
  return projectSecretsApi.deleteProjectSecret(projectId, id).map(() => {
    refreshProjectSecrets(projectId, layer);
  });
}
