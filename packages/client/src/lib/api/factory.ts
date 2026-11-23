/**
 * The caller's issue factory for a project (change issue-factory): settings,
 * runs and the queue of issues sent to it (change factory-manual-queue), over tRPC.
 */
import type {
  SaveFactorySettingsInput,
  SubmitFactoryIssuesInput,
} from '@funny/shared/contracts/factory';

import { trpc, trpcCall } from './_trpc';

export type {
  FactoryMode,
  FactoryQueueClearResult,
  FactoryQueueRun,
  FactoryRegressionProof,
  FactoryRun,
  FactorySettings,
  FactorySubmitResult,
  FactoryWaitReason,
  SaveFactorySettingsInput,
} from '@funny/shared/contracts/factory';

const procedures = trpc.factory;

export const factoryApi = {
  getSettings: (projectId: string) => trpcCall(() => procedures.settings.query({ projectId })),
  saveSettings: (data: SaveFactorySettingsInput) => trpcCall(() => procedures.save.mutate(data)),
  listRuns: (projectId: string) => trpcCall(() => procedures.runs.query({ projectId })),
  listActiveRuns: () => trpcCall(() => procedures.activeRuns.query()),
  listQueueRuns: () => trpcCall(() => procedures.queueRuns.query()),
  stopRun: (projectId: string, runId: string) =>
    trpcCall(() => procedures.stopRun.mutate({ projectId, runId })),
  retryRun: (projectId: string, runId: string) =>
    trpcCall(() => procedures.retryRun.mutate({ projectId, runId })),
  submitIssues: (input: SubmitFactoryIssuesInput) =>
    trpcCall(() => procedures.submitIssues.mutate(input)),
  listFlows: (projectId: string) => trpcCall(() => procedures.flows.query({ projectId })),
  getFlowDefinition: (projectId: string, flowName: string) =>
    trpcCall(() => procedures.flowDefinition.query({ projectId, flowName })),
  blockers: (projectId: string, issueNumbers: number[]) =>
    trpcCall(() => procedures.blockers.query({ projectId, issueNumbers })),
  clearQueue: (projectId: string) => trpcCall(() => procedures.clearQueue.mutate({ projectId })),
  stopAll: (projectId: string) => trpcCall(() => procedures.stopAll.mutate({ projectId })),
  closeIncident: (projectId: string) =>
    trpcCall(() => procedures.closeIncident.mutate({ projectId })),
};
