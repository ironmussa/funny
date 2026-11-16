/**
 * The caller's own issue factory for a project (change issue-factory), for the
 * `factory` tRPC router. The procedure checked the project capability; the
 * settings service re-checks it and scopes every row to the caller. Saving
 * reschedules the server's watcher, so an enable or disable applies at once.
 */

import { failure, type ApiFailure, type FactoryPort } from '@funny/api';
import { errAsync, okAsync } from 'neverthrow';

import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import {
  createFactoryRunControl,
  type FactoryRunControlError,
} from '../../services/factory/factory-run-control.js';
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

function controlFailure(error: FactoryRunControlError): ApiFailure {
  if (error.kind === 'storage') return storageFailure(error);
  return failure(error.kind === 'not-found' ? 404 : 409, error.message);
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
  control = createFactoryRunControl(runs),
): FactoryPort {
  /** The caller's factory for the project; 404 when they have none. */
  const ownFactory = (userId: string, projectId: string) =>
    settings
      .factoryId(userId, projectId)
      .mapErr(settingsFailure)
      .andThen((factoryId) =>
        factoryId
          ? okAsync(factoryId)
          : errAsync<string, ApiFailure>(failure(404, 'Run not found')),
      );

  const controlled = (action: 'stop' | 'retry', userId: string, projectId: string, runId: string) =>
    ownFactory(userId, projectId)
      .andThen((factoryId) =>
        (action === 'stop'
          ? control.stop(userId, factoryId, runId)
          : control.retry(factoryId, runId)
        ).mapErr(controlFailure),
      )
      .map((run) => {
        audit({
          action: action === 'stop' ? 'factory.run_stopped' : 'factory.run_retried',
          actorId: userId,
          detail: `Factory run for issue #${run.issueNumber} ${action === 'stop' ? 'stopped' : 'retried'}`,
          meta: { projectId, runId, issueNumber: run.issueNumber },
        });
        return run;
      });

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

    async stopRun(userId, projectId, runId) {
      return controlled('stop', userId, projectId, runId);
    },

    async retryRun(userId, projectId, runId) {
      return controlled('retry', userId, projectId, runId);
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
