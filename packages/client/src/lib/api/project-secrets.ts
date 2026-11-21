/**
 * A project's secrets (openspec project-secrets), over tRPC. No call returns a
 * value: it goes in through `setProjectSecret` and reaches only the runner
 * that starts a thread's agent.
 */
import type { SetProjectSecretInput } from '@funny/shared/contracts/project-secrets';

import { trpc, trpcCall } from './_trpc';

export type {
  ProjectSecretSummary,
  SetProjectSecretInput,
} from '@funny/shared/contracts/project-secrets';

const procedures = trpc.projectSecrets;

export const projectSecretsApi = {
  listProjectSecrets: (projectId: string) => trpcCall(() => procedures.list.query({ projectId })),
  /** Leave `value` out to keep the stored value of a secret that exists. */
  setProjectSecret: (data: SetProjectSecretInput) => trpcCall(() => procedures.set.mutate(data)),
  deleteProjectSecret: (projectId: string, id: string) =>
    trpcCall(() => procedures.delete.mutate({ projectId, id })),
};
