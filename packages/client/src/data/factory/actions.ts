import type { FactoryApprovalRequest } from '@funny/shared/contracts/factory';
import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import {
  factoryApi,
  type FactoryQueueCiProposal,
  type FactoryQueueClearResult,
  type FactoryRun,
  type FactorySettings,
  type FactorySubmitResult,
  type FactoryTrigger,
  type SaveFactorySettingsInput,
} from '@/lib/api/factory';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import {
  refetchFactorySettings,
  refreshFactoryApprovalRequests,
  refreshFactoryReadiness,
  refreshFactoryRuns,
  refreshFactoryTriggers,
  writeFactoryApprovalRequest,
  writeFactoryRun,
  writeFactorySettings,
} from './queries';

/** Try the caller's factory settings again after a failed read. */
export function retryFactorySettings(
  projectId: string,
  layer: DataLayer = getDataLayer(),
): Promise<void> {
  return refetchFactorySettings(projectId, layer);
}

/**
 * Save the caller's factory settings for a project. Not optimistic: the panel
 * waits on the answer, and only the server's confirmed row is recorded, so a
 * refused save (e.g. a viewer, or an invalid flow name) leaves the cached
 * settings as they were. The caller shows the error.
 */
export function saveFactorySettings(
  data: SaveFactorySettingsInput,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactorySettings, DomainError> {
  return factoryApi.saveSettings(data).map((settings) => {
    writeFactorySettings(settings, layer);
    return settings;
  });
}

/**
 * Stop or retry one run of the caller's factory. Not optimistic: the server
 * decides whether the run can still be controlled, and its answer is recorded.
 * The caller shows the error.
 */
export function controlFactoryRun(
  action: 'stop' | 'retry',
  projectId: string,
  runId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryRun, DomainError> {
  const call = { stop: factoryApi.stopRun, retry: factoryApi.retryRun }[action];
  return call(projectId, runId).map((run) => {
    writeFactoryRun(projectId, run, layer);
    return run;
  });
}

/**
 * Approve merging the high-risk change a run holds. `expectedSha` is the
 * commit on screen: the server refuses when the run is held on another one.
 * Not optimistic, like `controlFactoryRun`.
 */
export function approveFactoryMerge(
  projectId: string,
  runId: string,
  expectedSha: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryRun, DomainError> {
  return factoryApi.approveMerge(projectId, runId, expectedSha).map((run) => {
    writeFactoryRun(projectId, run, layer);
    // An approval closes the request an agent made for this commit.
    refreshFactoryApprovalRequests(projectId, layer);
    return run;
  });
}

/**
 * Mark (or unmark) a run as a lint cleanup: its size and its contract's risk
 * hints then do not hold it, when the factory's own checks of the diff pass. A
 * run held for its risk goes back in flight. Not optimistic: the server says
 * what the run is doing now. The caller shows the error.
 */
export function setFactoryRunLintCleanup(
  projectId: string,
  runId: string,
  lintCleanup: boolean,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryRun, DomainError> {
  return factoryApi.setLintCleanup(projectId, runId, lintCleanup).map((run) => {
    writeFactoryRun(projectId, run, layer);
    return run;
  });
}

/**
 * Decline an agent's request to approve a held merge. The run stays held and
 * nothing is approved. Not optimistic: the server says whether the request was
 * still pending. The caller shows the error.
 */
export function declineFactoryApprovalRequest(
  projectId: string,
  requestId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryApprovalRequest, DomainError> {
  return factoryApi.declineApprovalRequest(projectId, requestId).map((request) => {
    writeFactoryApprovalRequest(projectId, request, layer);
    return request;
  });
}

/**
 * Send chosen issues to the caller's factory with one flow. Not optimistic:
 * the server checks the factory can work now and answers per issue; the runs
 * are re-read so the queued ones show at once. The caller shows refusals.
 */
export function sendIssuesToFactory(
  projectId: string,
  issueNumbers: number[],
  flowName: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactorySubmitResult, DomainError> {
  return factoryApi.submitIssues({ projectId, issueNumbers, flowName }).map((result) => {
    refreshFactoryRuns(projectId, layer);
    return result;
  });
}

/**
 * Open the issue that adds CI on the merge queue's branches and send it to
 * the caller's factory (openspec factory-integration D12). Not optimistic;
 * the runs and the readiness are re-read afterwards. The caller shows the error.
 */
export function proposeQueueCi(
  projectId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryQueueCiProposal, DomainError> {
  return factoryApi.proposeQueueCi(projectId).map((result) => {
    refreshFactoryRuns(projectId, layer);
    refreshFactoryReadiness(projectId, layer);
    return result;
  });
}

/**
 * Clear the caller's factory queue, or (`stop-all`) clear it and stop every
 * run in progress. Not optimistic; the runs are re-read afterwards.
 */
export function emptyFactory(
  action: 'clear-queue' | 'stop-all',
  projectId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryQueueClearResult, DomainError> {
  const call = action === 'clear-queue' ? factoryApi.clearQueue : factoryApi.stopAll;
  return call(projectId).map((result) => {
    refreshFactoryRuns(projectId, layer);
    return result;
  });
}

/**
 * Close the incident that pauses the caller's factory (a broken base branch),
 * so its admissions resume. Not optimistic: the server's settings, without
 * the incident, are recorded. The caller shows the error.
 */
export function closeFactoryIncident(
  projectId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactorySettings, DomainError> {
  return factoryApi.closeIncident(projectId).map((settings) => {
    writeFactorySettings(settings, layer);
    return settings;
  });
}

/** What a schedule trigger's form sends: `id` when it changes an existing one. */
export interface FactoryTriggerDraft {
  id?: string;
  name: string;
  schedule: string;
  flowName: string;
  inputs: Record<string, string>;
  enabled: boolean;
}

/**
 * Create or change a schedule trigger of the caller's factory (change
 * flow-triggers). Not optimistic: the server checks the schedule and that the
 * flow can run without an issue. The caller shows the error.
 */
export function saveFactoryTrigger(
  projectId: string,
  draft: FactoryTriggerDraft,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryTrigger, DomainError> {
  return factoryApi.saveTrigger({ projectId, ...draft }).map((trigger) => {
    refreshFactoryTriggers(projectId, layer);
    return trigger;
  });
}

/** Remove a schedule trigger of the caller's factory. */
export function removeFactoryTrigger(
  projectId: string,
  triggerId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<{ ok: true }, DomainError> {
  return factoryApi.removeTrigger(projectId, triggerId).map((result) => {
    refreshFactoryTriggers(projectId, layer);
    return result;
  });
}

/**
 * Start one run of a flow now, without an issue. Not optimistic: the server
 * checks the factory can work and the inputs; the runs are re-read so the new
 * one shows at once.
 */
export function runFactoryFlow(
  projectId: string,
  flowName: string,
  inputs: Record<string, string>,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryRun, DomainError> {
  return factoryApi.runFlow({ projectId, flowName, inputs }).map((run) => {
    refreshFactoryRuns(projectId, layer);
    return run;
  });
}
