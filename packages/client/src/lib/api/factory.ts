/** The caller's issue factory for a project (change issue-factory): settings + runs, over tRPC. */
import type { SaveFactorySettingsInput } from '@funny/shared/contracts/factory';

import { trpc, trpcCall } from './_trpc';

export type {
  FactoryRun,
  FactorySettings,
  SaveFactorySettingsInput,
} from '@funny/shared/contracts/factory';

const procedures = trpc.factory;

export const factoryApi = {
  getSettings: (projectId: string) => trpcCall(() => procedures.settings.query({ projectId })),
  saveSettings: (data: SaveFactorySettingsInput) => trpcCall(() => procedures.save.mutate(data)),
  listRuns: (projectId: string) => trpcCall(() => procedures.runs.query({ projectId })),
  stopRun: (projectId: string, runId: string) =>
    trpcCall(() => procedures.stopRun.mutate({ projectId, runId })),
  retryRun: (projectId: string, runId: string) =>
    trpcCall(() => procedures.retryRun.mutate({ projectId, runId })),
};
