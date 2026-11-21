import type { ProjectSecretSummary } from '@/lib/api/project-secrets';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { projectSecretsQuery } from './queries';

/** A complete `ProjectSecretSummary` for tests and stories (a shared secret); overrides win. */
export function buildProjectSecret(
  overrides: Partial<ProjectSecretSummary> = {},
): ProjectSecretSummary {
  return {
    id: 'secret-1',
    name: 'API_KEY',
    scope: 'project',
    allowInSandbox: false,
    updatedBy: 'user-1',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

/** Make `secrets` the list a project's readers see, without a request. */
export function seedProjectSecrets(
  projectId: string,
  secrets: ProjectSecretSummary[],
  layer: DataLayer = getDataLayer(),
): void {
  layer.queryClient.setQueryData<ProjectSecretSummary[]>(
    projectSecretsQuery(projectId).queryKey,
    secrets,
  );
}
