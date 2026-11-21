import { projectSecretsApi, type ProjectSecretSummary } from '@/lib/api/project-secrets';

import type { DataLayer } from '../data-layer';
import { unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';

/**
 * A project's secrets as the caller may see them: the shared ones plus their
 * own, names and settings only. A request-shaped list with no realtime event;
 * another member's change shows on the next read.
 */

const projectSecretsKey = (projectId: string) => ['project-secrets', projectId] as const;

export function projectSecretsQuery(projectId: string) {
  return {
    queryKey: projectSecretsKey(projectId),
    queryFn: (): Promise<ProjectSecretSummary[]> =>
      unwrapResult(projectSecretsApi.listProjectSecrets(projectId)),
    staleTime: 30_000,
  };
}

/** Re-read the list after a write the server accepted. */
export function refreshProjectSecrets(projectId: string, layer: DataLayer = getDataLayer()): void {
  if (layer.disposed) return;
  void layer.queryClient.invalidateQueries({ queryKey: projectSecretsKey(projectId) });
}
