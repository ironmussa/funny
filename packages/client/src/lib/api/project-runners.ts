import type { UpdateProjectRunnerSettingsRequest } from '@funny/shared/runner-protocol';

import { trpc, trpcCall } from './_trpc';

const procedures = trpc.projectRunners;

export const projectRunnersApi = {
  getProjectRunnerSettings: (projectId: string) =>
    trpcCall(() => procedures.settings.query({ projectId })),
  updateProjectRunnerSettings: (projectId: string, data: UpdateProjectRunnerSettingsRequest) =>
    trpcCall(() => procedures.update.mutate({ projectId, data })),
  grantProjectRunner: (projectId: string, runnerId: string) =>
    trpcCall(() => procedures.grant.mutate({ projectId, runnerId })),
  revokeProjectRunner: (projectId: string, runnerId: string) =>
    trpcCall(() => procedures.revoke.mutate({ projectId, runnerId })),
  setGeneralRunner: (runnerId: string | null) =>
    trpcCall(() => procedures.setGeneralRunner.mutate({ runnerId })),
};
