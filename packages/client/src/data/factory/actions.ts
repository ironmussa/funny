import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import {
  factoryApi,
  type FactoryQueueClearResult,
  type FactoryRun,
  type FactorySettings,
  type FactorySubmitResult,
  type SaveFactorySettingsInput,
} from '@/lib/api/factory';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import {
  refetchFactorySettings,
  refreshFactoryRuns,
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
 * decides whether the run can still be stopped or retried, and its answer is
 * recorded. The caller shows the error.
 */
export function controlFactoryRun(
  action: 'stop' | 'retry',
  projectId: string,
  runId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<FactoryRun, DomainError> {
  const call = action === 'stop' ? factoryApi.stopRun : factoryApi.retryRun;
  return call(projectId, runId).map((run) => {
    writeFactoryRun(projectId, run, layer);
    return run;
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
