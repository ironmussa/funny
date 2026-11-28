/**
 * What the `factory` tRPC port's parts share (`factory.ts`): its
 * repositories and services, the caller's factory lookups, and how service
 * errors become API failures.
 */

import { failure, type ApiFailure } from '@funny/api';
import { errorMessage } from '@funny/shared/errors';
import { errAsync, okAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { createFactoryApprovalRequestsRepository } from '../../services/factory/factory-approval-requests.js';
import {
  createFactoryIncidentsRepository,
  publicIncident,
} from '../../services/factory/factory-incidents.js';
import {
  createFactoryQueue,
  type FactoryQueueError,
} from '../../services/factory/factory-queue.js';
import {
  createFactoryRunControl,
  type FactoryRunControlError,
} from '../../services/factory/factory-run-control.js';
import { createFactoryRunsRepository } from '../../services/factory/factory-runs.js';
import {
  createFactorySettingsService,
  type FactorySettingsError,
} from '../../services/factory/factory-settings.js';
import { rescheduleFactory } from '../../services/factory/factory-watcher.js';

const STATUS: Record<'not-found' | 'forbidden' | 'invalid' | 'storage', 400 | 403 | 404 | 500> = {
  'not-found': 404,
  forbidden: 403,
  invalid: 400,
  storage: 500,
};

export function settingsFailure(error: FactorySettingsError): ApiFailure {
  if (error.kind === 'storage') {
    log.error('Factory settings storage failure', { namespace: 'factory', error: error.message });
    return failure(500, 'Internal error');
  }
  if (error.kind === 'flow-not-ready') {
    return {
      status: 409,
      message: error.message,
      friendlyMessage: error.message,
      code: 'flow-not-ready',
    };
  }
  if (error.kind === 'flow-not-checked') {
    return {
      status: 503,
      message: error.message,
      friendlyMessage: error.message,
      code: 'flow-not-checked',
    };
  }
  return failure(STATUS[error.kind], error.message);
}

export function controlFailure(error: FactoryRunControlError): ApiFailure {
  if (error.kind === 'storage') return storageFailure(error);
  if (error.kind === 'github') return failure(502, error.message);
  return failure(error.kind === 'not-found' ? 404 : 409, error.message);
}

export function queueFailure(error: FactoryQueueError): ApiFailure {
  switch (error.kind) {
    case 'storage':
      return storageFailure(error);
    case 'not-found':
      return failure(404, error.message);
    case 'invalid-flow':
    case 'invalid':
      return failure(400, error.message);
    default:
      // paused / cannot-work: the factory exists but cannot take a send now.
      return failure(409, error.message);
  }
}

export const storageFailure = (error: { message: string }) => {
  log.error('Factory runs storage failure', { namespace: 'factory', error: error.message });
  return failure(500, 'Internal error');
};

/** Pick up a saved change in the running watcher; best-effort (it may not be running). */
export async function reschedule(factoryId: string, projectId: string): Promise<void> {
  await rescheduleFactory(factoryId).catch((cause: unknown) =>
    log.error('Failed to reschedule factory', {
      namespace: 'factory',
      projectId,
      error: errorMessage(cause),
    }),
  );
}

/** The repositories and services the factory port acts through. */
export interface FactoryPortDeps {
  settings: ReturnType<typeof createFactorySettingsService>;
  runs: ReturnType<typeof createFactoryRunsRepository>;
  control: ReturnType<typeof createFactoryRunControl>;
  queue: ReturnType<typeof createFactoryQueue>;
  incidents: ReturnType<typeof createFactoryIncidentsRepository>;
  requests: ReturnType<typeof createFactoryApprovalRequestsRepository>;
}

/** The caller's factory lookups, as API results. */
export function factoryScope({ settings, incidents }: FactoryPortDeps) {
  /** The caller's factory for the project; 404 with `missing` when they have none. */
  const factoryOf = (userId: string, projectId: string, missing: string) =>
    settings
      .factoryId(userId, projectId)
      .mapErr(settingsFailure)
      .andThen((factoryId) =>
        factoryId ? okAsync(factoryId) : errAsync<string, ApiFailure>(failure(404, missing)),
      );
  const ownFactory = (userId: string, projectId: string) =>
    factoryOf(userId, projectId, 'Run not found');
  const ownFactoryOr = factoryOf;
  const configured = (userId: string, projectId: string) =>
    factoryOf(userId, projectId, 'Set up the issue factory first.');

  /** The caller's settings with the incident that pauses their factory, when one does. */
  const settingsWithIncident = (userId: string, projectId: string) =>
    settings
      .get(userId, projectId)
      .mapErr(settingsFailure)
      .andThen((view) => {
        if (!view) return okAsync(null);
        return settings
          .factoryId(userId, projectId)
          .mapErr(settingsFailure)
          .andThen((factoryId) =>
            factoryId
              ? incidents.activeForFactory(factoryId).mapErr(storageFailure)
              : okAsync(null),
          )
          .map((incident) => ({ ...view, incident: incident ? publicIncident(incident) : null }));
      });

  return { factoryOf, ownFactory, ownFactoryOr, configured, settingsWithIncident };
}

export type FactoryScope = ReturnType<typeof factoryScope>;
