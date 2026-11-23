/**
 * The caller's own issue factory for a project (change issue-factory), for the
 * `factory` tRPC router. The procedure checked the project capability; the
 * settings service re-checks it and scopes every row to the caller. Saving
 * reschedules the server's watcher, so an enable or disable applies at once.
 */

import { failure, type ApiFailure, type FactoryPort } from '@funny/api';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { BUILT_IN_FACTORY_FLOWS } from '../../services/factory/factory-flow.js';
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
import {
  createFactoryRunsRepository,
  type FactoryRunView,
} from '../../services/factory/factory-runs.js';
import {
  createFactorySettingsService,
  setFactoryBlocked,
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

function queueFailure(error: FactoryQueueError): ApiFailure {
  switch (error.kind) {
    case 'storage':
      return storageFailure(error);
    case 'not-found':
      return failure(404, error.message);
    case 'invalid-flow':
      return failure(400, error.message);
    default:
      // paused / cannot-work: the factory exists but cannot take a send now.
      return failure(409, error.message);
  }
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
  queue = createFactoryQueue({ runs, control }),
  incidents = createFactoryIncidentsRepository(),
): FactoryPort {
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

  /** Audit a queue action and pass its result on. */
  const audited =
    <T>(
      action: 'factory.issues_sent' | 'factory.queue_cleared' | 'factory.stopped_all',
      userId: string,
      detail: (result: T) => string,
      meta: (result: T) => Record<string, unknown>,
    ) =>
    (result: T): T => {
      audit({ action, actorId: userId, detail: detail(result), meta: meta(result) });
      return result;
    };

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
      return settingsWithIncident(userId, projectId);
    },

    async closeIncident(userId, projectId) {
      return configured(userId, projectId)
        .andThen((factoryId) =>
          incidents
            .activeForFactory(factoryId)
            .mapErr(storageFailure)
            .andThen((incident) =>
              incident
                ? okAsync({ factoryId, incident })
                : errAsync<never, ApiFailure>(
                    failure(404, 'No incident is open for this factory.'),
                  ),
            ),
        )
        .andThen(({ factoryId, incident }) =>
          incidents
            .close(incident.id, userId)
            .mapErr(storageFailure)
            .map(() => {
              audit({
                action: 'factory.incident_closed',
                actorId: userId,
                detail: `Incident on ${incident.baseBranch} of ${incident.repo} closed by a member`,
                meta: { projectId, incidentId: incident.id, repo: incident.repo },
              });
              return factoryId;
            }),
        )
        .andThen((factoryId) =>
          // The reason the watcher wrote goes with the incident; the next tick writes what holds now.
          ResultAsync.fromSafePromise(
            setFactoryBlocked(factoryId, null).then(() => reschedule(factoryId, projectId)),
          ),
        )
        .andThen(() => settingsWithIncident(userId, projectId))
        .andThen((view) =>
          view ? okAsync(view) : errAsync<never, ApiFailure>(failure(404, 'Factory not found')),
        );
    },

    async save(userId, projectId, data) {
      const saved = await settings.save(userId, projectId, data).mapErr(settingsFailure);
      if (saved.isErr()) return saved;
      audit({
        action: 'factory.settings_set',
        actorId: userId,
        detail: `Project ${projectId} factory ${saved.value.enabled ? 'enabled' : 'disabled'}`,
        meta: {
          projectId,
          enabled: saved.value.enabled,
          mode: saved.value.mode,
          label: saved.value.label,
        },
      });
      const factoryId = await settings.factoryId(userId, projectId);
      if (factoryId.isOk() && factoryId.value) await reschedule(factoryId.value, projectId);
      // An open incident stays shown after a save: the answer carries it too.
      const incident =
        factoryId.isOk() && factoryId.value
          ? await incidents.activeForFactory(factoryId.value)
          : null;
      const paused = incident?.isOk() && incident.value ? publicIncident(incident.value) : null;
      return saved.map((view) => ({ ...view, incident: paused }));
    },

    async stopRun(userId, projectId, runId) {
      return controlled('stop', userId, projectId, runId);
    },

    async retryRun(userId, projectId, runId) {
      return controlled('retry', userId, projectId, runId);
    },

    async submitIssues(userId, projectId, input) {
      return configured(userId, projectId).andThen((factoryId) =>
        queue
          .submit(factoryId, input)
          .mapErr(queueFailure)
          .map(
            audited(
              'factory.issues_sent',
              userId,
              (r) => `Sent ${r.accepted.length} issue(s) to the factory of project ${projectId}`,
              (r) => ({
                projectId,
                flowName: input.flowName,
                accepted: r.accepted,
                refused: r.refused.map((refusal) => refusal.issue),
              }),
            ),
          ),
      );
    },

    async flows(userId, projectId) {
      return settings
        .factoryId(userId, projectId)
        .mapErr(settingsFailure)
        .andThen((factoryId) =>
          factoryId
            ? queue.flows(factoryId).mapErr(queueFailure)
            : okAsync(
                BUILT_IN_FACTORY_FLOWS.map((name) => ({ name, source: 'built-in' as const })),
              ),
        );
    },

    async flowDefinition(userId, projectId, flowName) {
      return settings
        .factoryId(userId, projectId)
        .mapErr(settingsFailure)
        .andThen((factoryId) => queue.flowDefinition(factoryId, flowName).mapErr(queueFailure));
    },

    async validateFlow(userId, projectId, flowName) {
      return settings
        .factoryId(userId, projectId)
        .mapErr(settingsFailure)
        .andThen((factoryId) =>
          queue.validateFlow(factoryId, projectId, flowName).mapErr(queueFailure),
        );
    },

    async blockers(userId, projectId, issueNumbers) {
      return settings
        .factoryId(userId, projectId)
        .mapErr(settingsFailure)
        .andThen((factoryId) =>
          factoryId ? queue.blockers(factoryId, issueNumbers).mapErr(queueFailure) : okAsync([]),
        );
    },

    async clearQueue(userId, projectId) {
      return configured(userId, projectId).andThen((factoryId) =>
        queue
          .clearQueue(factoryId)
          .mapErr(queueFailure)
          .map(
            audited(
              'factory.queue_cleared',
              userId,
              (r) => `Cleared ${r.cleared} queued issue(s) of the factory of project ${projectId}`,
              (r) => ({ projectId, cleared: r.cleared }),
            ),
          ),
      );
    },

    async stopAll(userId, projectId) {
      return configured(userId, projectId).andThen((factoryId) =>
        queue
          .stopAll(userId, factoryId)
          .mapErr(queueFailure)
          .map(
            audited(
              'factory.stopped_all',
              userId,
              (r) =>
                `Stopped the factory of project ${projectId}: ${r.cleared} queued, ${r.stopped} running`,
              (r) => ({ projectId, ...r }),
            ),
          ),
      );
    },

    async activeRuns(userId) {
      return runs.activeForOwner(userId).mapErr(storageFailure);
    },

    async queueRuns(userId) {
      return runs.queueForOwner(userId).mapErr(storageFailure);
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
