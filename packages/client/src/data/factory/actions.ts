import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import {
  factoryApi,
  type FactoryRun,
  type FactorySettings,
  type SaveFactorySettingsInput,
} from '@/lib/api/factory';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { writeFactoryRun, writeFactorySettings } from './queries';

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
