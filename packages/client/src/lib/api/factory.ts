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
  FactoryLane,
  FactoryLaneFinishResult,
  FactoryLaneState,
  FactoryLaneSyncResult,
  FactoryLaneSyncState,
  FactoryMode,
  FactoryQueueCiProposal,
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
  listQueueLanes: () => trpcCall(() => procedures.queueLanes.query()),
  stopRun: (projectId: string, runId: string) =>
    trpcCall(() => procedures.stopRun.mutate({ projectId, runId })),
  retryRun: (projectId: string, runId: string) =>
    trpcCall(() => procedures.retryRun.mutate({ projectId, runId })),
  splitRun: (projectId: string, runId: string) =>
    trpcCall(() => procedures.splitRun.mutate({ projectId, runId })),
  approveMerge: (projectId: string, runId: string, expectedSha: string) =>
    trpcCall(() => procedures.approveMerge.mutate({ projectId, runId, expectedSha })),
  markRunDone: (projectId: string, runId: string) =>
    trpcCall(() => procedures.markRunDone.mutate({ projectId, runId })),
  holdRun: (projectId: string, runId: string, reason: string) =>
    trpcCall(() => procedures.holdRun.mutate({ projectId, runId, reason })),
  releaseRun: (projectId: string, runId: string) =>
    trpcCall(() => procedures.releaseRun.mutate({ projectId, runId })),
  approveSpec: (projectId: string, runId: string, revision: number) =>
    trpcCall(() => procedures.approveSpec.mutate({ projectId, runId, revision })),
  reopenSpec: (projectId: string, runId: string) =>
    trpcCall(() => procedures.reopenSpec.mutate({ projectId, runId })),
  closeReplacedPr: (projectId: string, runId: string) =>
    trpcCall(() => procedures.closeReplacedPr.mutate({ projectId, runId })),
  setLintCleanup: (projectId: string, runId: string, lintCleanup: boolean) =>
    trpcCall(() => procedures.setLintCleanup.mutate({ projectId, runId, lintCleanup })),
  listApprovalRequests: (projectId: string) =>
    trpcCall(() => procedures.approvalRequests.query({ projectId })),
  declineApprovalRequest: (projectId: string, requestId: string) =>
    trpcCall(() => procedures.declineApprovalRequest.mutate({ projectId, requestId })),
  submitIssues: (input: SubmitFactoryIssuesInput) =>
    trpcCall(() => procedures.submitIssues.mutate(input)),
  listFlows: (projectId: string) => trpcCall(() => procedures.flows.query({ projectId })),
  getFlowDefinition: (projectId: string, flowName: string) =>
    trpcCall(() => procedures.flowDefinition.query({ projectId, flowName })),
  readiness: (projectId: string) => trpcCall(() => procedures.readiness.query({ projectId })),
  proposeQueueCi: (projectId: string) =>
    trpcCall(() => procedures.proposeQueueCi.mutate({ projectId })),
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
  // Lanes (openspec factory-lanes).
  listLanes: (projectId: string) => trpcCall(() => procedures.lanes.list.query({ projectId })),
  removeLane: (projectId: string, name: string) =>
    trpcCall(() => procedures.lanes.remove.mutate({ projectId, name })),
  syncLane: (projectId: string, name: string) =>
    trpcCall(() => procedures.lanes.sync.mutate({ projectId, name })),
  finishLane: (projectId: string, name: string) =>
    trpcCall(() => procedures.lanes.finish.mutate({ projectId, name })),
};
