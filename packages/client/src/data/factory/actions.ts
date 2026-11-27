import type {
  FactoryApprovalRequest,
  FactoryReplacedPrClose,
  FactoryRunRoute,
} from '@funny/shared/contracts/factory';
import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import {
  factoryApi,
  type FactoryLaneFinishResult,
  type FactoryLaneSyncResult,
  type FactoryQueueCiProposal,
  type FactoryQueueClearResult,
  type FactoryRun,
  type FactorySettings,
  type FactorySubmitResult,
  type FactoryTrigger,
  type SaveFactorySettingsInput,
} from '@/lib/api/factory';

import type { DataLayer } from '../data-layer';
import { fetchPRDetail } from '../pull-requests/queries';
import { getDataLayer } from '../runtime';
import {
  refetchFactorySettings,
  refreshFactoryApprovalRequests,
  refreshFactoryLanes,
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
 * Stop, retry or split one run of the caller's factory. Not optimistic: the
 * server decides whether the run can still be controlled, and its answer is
 * recorded. The caller shows the error.
 */
export function controlFactoryRun(
  action: 'stop' | 'retry' | 'split',
  projectId: string,
  runId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryRun, DomainError> {
  const call = {
    stop: factoryApi.stopRun,
    retry: factoryApi.retryRun,
    split: factoryApi.splitRun,
  }[action];
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
 * Mark a run that ended with no change as done: the member agrees nothing
 * needs changing. Not optimistic: the server says whether the run was still
 * in that state. The caller shows the error.
 */
export function markFactoryRunDone(
  projectId: string,
  runId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryRun, DomainError> {
  return factoryApi.markRunDone(projectId, runId).map((run) => {
    writeFactoryRun(projectId, run, layer);
    return run;
  });
}

/**
 * Put a run on hold with the member's reason, or release one: not optimistic,
 * the server says whether the run was in a state for it. The caller shows the
 * error.
 */
export function holdFactoryRun(
  projectId: string,
  runId: string,
  reason: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryRun, DomainError> {
  return factoryApi.holdRun(projectId, runId, reason).map((run) => {
    writeFactoryRun(projectId, run, layer);
    return run;
  });
}

export function releaseFactoryRun(
  projectId: string,
  runId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryRun, DomainError> {
  return factoryApi.releaseRun(projectId, runId).map((run) => {
    writeFactoryRun(projectId, run, layer);
    return run;
  });
}

/**
 * Approve the spec draft of `revision` a run waits on (openspec
 * factory-spec-stage): the revision is the one on screen, and the server
 * refuses when a newer draft was stored. Not optimistic: on a refusal the
 * runs are read again, so the member sees the newer draft. The caller shows
 * the error.
 */
export function approveFactorySpec(
  projectId: string,
  runId: string,
  revision: number,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryRun, DomainError> {
  return factoryApi
    .approveSpec(projectId, runId, revision)
    .map((run) => {
      writeFactoryRun(projectId, run, layer);
      // An approval closes the request an agent made for this draft.
      refreshFactoryApprovalRequests(projectId, layer);
      return run;
    })
    .orTee(() => refreshFactoryRuns(projectId, layer));
}

/** Reopen a run's spec: the approval is dropped and the spec writer revises it. */
export function reopenFactorySpec(
  projectId: string,
  runId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryRun, DomainError> {
  return factoryApi.reopenSpec(projectId, runId).map((run) => {
    writeFactoryRun(projectId, run, layer);
    return run;
  });
}

/**
 * Close the pull request a replaced run left open, and delete its branch. The
 * server decides again that a newer run of the issue replaced it. The run does
 * not change; the PR's state is read again from GitHub so the card shows it
 * closed. The caller shows the error.
 */
export function closeFactoryReplacedPr(
  projectId: string,
  runId: string,
  prNumber: number,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryReplacedPrClose, DomainError> {
  return factoryApi.closeReplacedPr(projectId, runId).map((result) => {
    void fetchPRDetail(projectId, prNumber, { force: true }, layer);
    return result;
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
  /** The branches chosen for these issues alone; absent: the factory's settings. */
  route?: FactoryRunRoute,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactorySubmitResult, DomainError> {
  return factoryApi.submitIssues({ projectId, issueNumbers, flowName, route }).map((result) => {
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

/** Remove a lane of the caller's factory (refused while a run or sync is in flight). */
export function removeFactoryLane(
  projectId: string,
  name: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<{ ok: true }, DomainError> {
  return factoryApi.removeLane(projectId, name).map((result) => {
    refreshFactoryLanes(projectId, layer);
    return result;
  });
}

/** Ask the server to sync a lane now, or retry a sync that needs a person. */
export function syncFactoryLane(
  projectId: string,
  name: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryLaneSyncResult, DomainError> {
  return factoryApi.syncLane(projectId, name).map((result) => {
    refreshFactoryLanes(projectId, layer);
    return result;
  });
}

/** Open the finish pull request from a lane into the factory's base branch. */
export function finishFactoryLane(
  projectId: string,
  name: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryLaneFinishResult, DomainError> {
  return factoryApi.finishLane(projectId, name).map((result) => {
    refreshFactoryLanes(projectId, layer);
    return result;
  });
}
