/**
 * The caller's own issue factory for a project (change issue-factory), for the
 * `factory` tRPC router. The procedure checked the project capability; the
 * settings service re-checks it and scopes every row to the caller. Saving
 * reschedules the server's watcher, so an enable or disable applies at once.
 */

import { failure, type ApiFailure, type FactoryPort } from '@funny/api';
import { okAsync } from 'neverthrow';

import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import {
  createFactoryRunsRepository,
  type FactoryRunView,
} from '../../services/factory/factory-runs.js';
import {
  createFactorySettingsService,
  type FactorySettingsError,
} from '../../services/factory/factory-settings.js';
import { rescheduleFactory } from '../../services/factory/factory-watcher.js';

const STATUS: Record<FactorySettingsError['kind'], 400 | 403 | 404 | 500> = {
  'not-found': 404,
  forbidden: 403,
  invalid: 400,
  storage: 500,
};

function settingsFailure(error: FactorySettingsError): ApiFailure {
  if (error.kind === 'storage') {
    log.error('Factory settings storage failure', { namespace: 'factory', error: error.message });
    return failure(500, 'Internal error');
  }
  return failure(STATUS[error.kind], error.message);
}

const storageFailure = (error: { message: string }) => {
  log.error('Factory runs storage failure', { namespace: 'factory', error: error.message });
  return failure(500, 'Internal error');
};

/** Pick up a saved change in the running watcher; best-effort (it may not be running). */
async function reschedule(factoryId: string, projectId: string): Promise<void> {
  await rescheduleFactory(factoryId).catch((error: unknown) =>
    log.error('Failed to reschedule factory', {
      namespace: 'factory',
      projectId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

function createFactoryPort(
  settings = createFactorySettingsService(),
  runs = createFactoryRunsRepository(),
): FactoryPort {
  return {
    async settings(userId, projectId) {
      return settings.get(userId, projectId).mapErr(settingsFailure);
    },

    async save(userId, projectId, data) {
      const saved = await settings.save(userId, projectId, data).mapErr(settingsFailure);
      if (saved.isErr()) return saved;
      audit({
        action: 'factory.settings_set',
        actorId: userId,
        detail: `Project ${projectId} factory ${saved.value.enabled ? 'enabled' : 'disabled'}`,
        meta: { projectId, enabled: saved.value.enabled, label: saved.value.label },
      });
      const factoryId = await settings.factoryId(userId, projectId);
      if (factoryId.isOk() && factoryId.value) await reschedule(factoryId.value, projectId);
      return saved;
    },

    async runs(userId, projectId) {
      return settings
        .factoryId(userId, projectId)
        .mapErr(settingsFailure)
        .andThen((factoryId) =>
          factoryId
            ? runs.list(factoryId).mapErr(storageFailure)
            : okAsync<FactoryRunView[], ApiFailure>([]),
        );
    },
  };
}

export const factoryPort = createFactoryPort();
