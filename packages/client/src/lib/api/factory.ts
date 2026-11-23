/**
 * The caller's issue factory for a project (change issue-factory): settings,
 * runs and the queue of issues sent to it (change factory-manual-queue), over tRPC.
 */
import type {
  RunFactoryFlowInput,
  SaveFactorySettingsInput,
  SaveFactoryTriggerInput,
  SubmitFactoryIssuesInput,
} from '@funny/shared/contracts/factory';

import { trpc, trpcCall } from './_trpc';

export type {
  FactoryFlowAgentStep,
  FactoryFlowProblem,
  FactoryFlowValidation,
  FactoryIssuelessFlow,
  FactoryMode,
  FactoryQueueClearResult,
  FactoryQueueRun,
  FactoryReadiness,
  FactoryRegressionProof,
  FactoryRun,
  FactorySettings,
  FactoryStepOverride,
  FactoryStepOverrides,
  FactorySubmitResult,
  FactoryTrigger,
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
  readiness: (projectId: string) => trpcCall(() => procedures.readiness.query({ projectId })),
  validateFlow: (projectId: string, flowName: string) =>
    trpcCall(() => procedures.validateFlow.query({ projectId, flowName })),
  blockers: (projectId: string, issueNumbers: number[]) =>
    trpcCall(() => procedures.blockers.query({ projectId, issueNumbers })),
  clearQueue: (projectId: string) => trpcCall(() => procedures.clearQueue.mutate({ projectId })),
  stopAll: (projectId: string) => trpcCall(() => procedures.stopAll.mutate({ projectId })),
  closeIncident: (projectId: string) =>
    trpcCall(() => procedures.closeIncident.mutate({ projectId })),
  // Triggers and runs without an issue (change flow-triggers).
  listTriggers: (projectId: string) => trpcCall(() => procedures.triggers.query({ projectId })),
  saveTrigger: (input: SaveFactoryTriggerInput) =>
    trpcCall(() => procedures.saveTrigger.mutate(input)),
  removeTrigger: (projectId: string, triggerId: string) =>
    trpcCall(() => procedures.removeTrigger.mutate({ projectId, triggerId })),
  getIssuelessFlow: (projectId: string, flowName: string) =>
    trpcCall(() => procedures.issuelessFlow.query({ projectId, flowName })),
  runFlow: (input: RunFactoryFlowInput) => trpcCall(() => procedures.runFlow.mutate(input)),
};
