/**
 * The queue, flow and schedule methods of the `factory` tRPC port
 * (`factory.ts`), each audited when it changes something.
 */

import { type FactoryPort } from '@funny/api';
import { okAsync } from 'neverthrow';

import { audit, type AuditMeta } from '../../lib/audit.js';
import { BUILT_IN_FACTORY_FLOWS } from '../../services/factory/factory-flow.js';
import {
  queueFailure,
  settingsFailure,
  type FactoryPortDeps,
  type FactoryScope,
} from './factory-port-shared.js';

/** Audit a queue action and pass its result on. */
function audited<T>(
  action:
    | 'factory.issues_sent'
    | 'factory.queue_ci_proposed'
    | 'factory.queue_cleared'
    | 'factory.stopped_all'
    | 'factory.trigger_saved'
    | 'factory.trigger_removed'
    | 'factory.flow_started',
  userId: string,
  detail: (result: T) => string,
  meta: (result: T) => AuditMeta,
) {
  return (result: T): T => {
    audit({ action, actorId: userId, detail: detail(result), meta: meta(result) });
    return result;
  };
}

/** The queue, flow and schedule-trigger methods of the port. */
export function queuePortMethods(
  { settings, queue }: FactoryPortDeps,
  { configured }: FactoryScope,
): Pick<
  FactoryPort,
  | 'submitIssues'
  | 'flows'
  | 'flowDefinition'
  | 'readiness'
  | 'proposeQueueCi'
  | 'validateFlow'
  | 'blockers'
  | 'triggers'
  | 'saveTrigger'
  | 'removeTrigger'
  | 'issuelessFlow'
  | 'runFlow'
  | 'clearQueue'
  | 'stopAll'
> {
  return {
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

    async readiness(userId, projectId) {
      return settings
        .factoryId(userId, projectId)
        .mapErr(settingsFailure)
        .andThen((factoryId) => queue.readiness(factoryId).mapErr(queueFailure));
    },

    async proposeQueueCi(userId, projectId) {
      return configured(userId, projectId).andThen((factoryId) =>
        queue
          .proposeQueueCi(userId, factoryId)
          .mapErr(queueFailure)
          .map(
            audited(
              'factory.queue_ci_proposed',
              userId,
              (r) =>
                `Opened issue #${r.issueNumber} for CI on the merge queue's branches of project ${projectId}`,
              (r) => ({ projectId, issueNumber: r.issueNumber, queued: r.queued }),
            ),
          ),
      );
    },

    async validateFlow(userId, projectId, flowName) {
      return settings
        .factoryId(userId, projectId)
        .mapErr(settingsFailure)
        .andThen((factoryId) =>
          queue.validateFlow(factoryId, projectId, flowName, { userId }).mapErr(queueFailure),
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

    async triggers(userId, projectId) {
      return settings
        .factoryId(userId, projectId)
        .mapErr(settingsFailure)
        .andThen((factoryId) =>
          factoryId ? queue.triggers(factoryId).mapErr(queueFailure) : okAsync([]),
        );
    },

    async saveTrigger(userId, projectId, data) {
      return configured(userId, projectId).andThen((factoryId) =>
        queue
          .saveTrigger(factoryId, data)
          .mapErr(queueFailure)
          .map(
            audited(
              'factory.trigger_saved',
              userId,
              (t) => `Saved the schedule "${t.name}" of the factory of project ${projectId}`,
              (t) => ({ projectId, triggerId: t.id, flowName: t.flowName, schedule: t.schedule }),
            ),
          ),
      );
    },

    async removeTrigger(userId, projectId, triggerId) {
      return configured(userId, projectId).andThen((factoryId) =>
        queue
          .removeTrigger(factoryId, triggerId)
          .mapErr(queueFailure)
          .map(() => ({ ok: true as const }))
          .map(
            audited(
              'factory.trigger_removed',
              userId,
              () => `Removed a schedule of the factory of project ${projectId}`,
              () => ({ projectId, triggerId }),
            ),
          ),
      );
    },

    async issuelessFlow(userId, projectId, flowName) {
      return settings
        .factoryId(userId, projectId)
        .mapErr(settingsFailure)
        .andThen((factoryId) => queue.issuelessFlow(factoryId, flowName).mapErr(queueFailure));
    },

    async runFlow(userId, projectId, input) {
      return configured(userId, projectId).andThen((factoryId) =>
        queue
          .runFlow(factoryId, input)
          .mapErr(queueFailure)
          .map(
            audited(
              'factory.flow_started',
              userId,
              () => `Started the flow "${input.flowName}" in the factory of project ${projectId}`,
              (run) => ({ projectId, runId: run.id, flowName: input.flowName }),
            ),
          ),
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
  };
}
