import type { ProjectSecretSummary } from '@/lib/api/project-secrets';

import { useDataQuery } from '../hooks';
import { projectSecretsQuery } from './queries';

/** The project's shared secrets and the caller's own, by name; `undefined` while loading. */
export function useProjectSecrets(projectId: string): ProjectSecretSummary[] | undefined {
  return useDataQuery(projectSecretsQuery(projectId)).data;
}
