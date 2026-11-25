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
import {
  recordServerActivity,
  type ServerActivityOutcome,
} from '../../services/activities/server-activities.js';
import { factoryAgentToolsWith } from '../../services/factory/factory-agent-tools.js';
import {
  createFactoryApprovalRequestsRepository,
  publicApprovalRequest,
} from '../../services/factory/factory-approval-requests.js';
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
  factoryRunLabel,
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
    case 'invalid':
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

type RunControlAction = 'stop' | 'retry' | 'approve-merge';

/** A controlled run, and the commit the control was for (only an approval names one). */
interface ControlledRun {
  run: FactoryRunView;
  sha: string | null;
}

const withoutSha = (run: FactoryRunView): ControlledRun => ({
  run,
  sha: null,
});

/** How each run control is audited and titled in the member's activities. */
const RUN_CONTROL: Record<
  RunControlAction,
  {
    audit: 'factory.run_stopped' | 'factory.run_retried' | 'factory.merge_approved';
    kind: 'factory.stop' | 'factory.retry' | 'factory.approve-merge';
    /** `label` names the run: `for issue #12`, or its id when it has no issue. */
    auditDetail: (label: string, sha: string | null) => string;
    /** Past tense when it worked; what was asked when it did not (the row shows why). */
    title: (issue: number | null | undefined, sha: string | null, done: boolean) => string;
  }
> = {
  stop: {
    audit: 'factory.run_stopped',
    kind: 'factory.stop',
    auditDetail: (label) => `Factory run ${label} stopped`,
    title: (issue, _sha, done) =>
      `${done ? 'Stopped' : 'Stop'} the factory run${issue ? ` for #${issue}` : ''}`,
  },
  retry: {
    audit: 'factory.run_retried',
    kind: 'factory.retry',
    auditDetail: (label) => `Factory run ${label} retried`,
    title: (issue, _sha, done) =>
      `${done ? 'Retried' : 'Retry'} the factory run${issue ? ` for #${issue}` : ''}`,
  },
  'approve-merge': {
    audit: 'factory.merge_approved',
    kind: 'factory.approve-merge',
    auditDetail: (label, sha) =>
      `Merge of the high-risk change ${label} approved at ${sha ?? 'unknown commit'}`,
    title: (issue, sha, done) =>
      `${done ? 'Approved merging' : 'Approve merging'}${issue ? ` #${issue}` : ''}, a high-risk change${sha ? ` (${sha.slice(0, 7)})` : ''}`,
  },
};

/** The run control as a row of the member's activities; recording never fails the control. */
function recordRunControl(
  action: RunControlAction,
  userId: string,
  projectId: string,
  issueNumber: number | null | undefined,
  sha: string | null,
  outcome: ServerActivityOutcome,
  /** The thread whose agent asked, when a member did not (factory-agent-tools). */
  askedByThread?: string,
): Promise<void> {
  const { kind, title } = RUN_CONTROL[action];
  return recordServerActivity(
    {
      kind,
      userId,
      projectId,
      ...(askedByThread && { threadId: askedByThread }),
      title: `${title(issueNumber, sha, outcome.ok)}${askedByThread ? ' (asked by an agent)' : ''}`,
      input: {
        ...(typeof issueNumber === 'number' && { issueNumber }),
        ...(action === 'approve-merge' && sha && { sha }),
      },
      origin: askedByThread ? 'implicit' : 'user',
    },
    outcome,
  );
}

/** What a run control carries besides the run: the approved commit, or the asking thread. */
interface RunControlOptions {
  /** The commit the member was shown (`approve-merge` only). */
  expectedSha?: string;
  /** The thread whose agent asked for a retry or a stop. */
  askedByThread?: string;
}

/** The factory port, and the run controls an agent may use. */
interface FactoryParts {
  port: FactoryPort;
  controlled: ControlRun;
}

function createFactoryParts(
  settings = createFactorySettingsService(),
  runs = createFactoryRunsRepository(),
  control = createFactoryRunControl(runs),
  queue = createFactoryQueue({ runs, control }),
  incidents = createFactoryIncidentsRepository(),
  requests = createFactoryApprovalRequestsRepository(),
): FactoryParts {
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

  /** Audit a queue action and pass its result on. */
  const audited =
    <T>(
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
      meta: (result: T) => Record<string, unknown>,
    ) =>
    (result: T): T => {
      audit({ action, actorId: userId, detail: detail(result), meta: meta(result) });
      return result;
    };

  /**
   * A member's control over one run (stop, retry, approve a held merge): run,
   * audited, and shown in their activities whether it worked or not
   * (track-funny-actions).
   */
  const controlled = (
    action: RunControlAction,
    userId: string,
    projectId: string,
    runId: string,
    { expectedSha = '', askedByThread }: RunControlOptions = {},
  ): ResultAsync<FactoryRunView, ApiFailure> =>
    ownFactory(userId, projectId)
      .andThen((factoryId) => {
        const run = {
          stop: () => control.stop(userId, factoryId, runId).map(withoutSha),
          retry: () => control.retry(factoryId, runId).map(withoutSha),
          'approve-merge': () => control.approveMerge(userId, factoryId, runId, expectedSha),
        }[action];
        return run().mapErr(controlFailure);
      })
      .andTee(({ run, sha }) => {
        audit({
          action: RUN_CONTROL[action].audit,
          actorId: userId,
          detail: RUN_CONTROL[action].auditDetail(factoryRunLabel(run), sha),
          meta: {
            projectId,
            runId,
            issueNumber: run.issueNumber,
            ...(sha && { sha }),
            ...(askedByThread && { askedByThread }),
          },
        });
        void recordRunControl(
          action,
          userId,
          projectId,
          run.issueNumber,
          sha,
          { ok: true },
          askedByThread,
        );
        // An approval closes the run's pending request; a stop expires it.
        void requests
          .sync(run.id, run, action === 'approve-merge' ? userId : null)
          .mapErr((error) =>
            log.warn('Could not close a factory approval request', {
              namespace: 'factory',
              runId: run.id,
              error: error.message,
            }),
          );
      })
      .orTee((error) => {
        // The run's issue, when the run can still be read, names the failed action.
        void runs
          .get(runId)
          .map((run) =>
            recordRunControl(
              action,
              userId,
              projectId,
              run?.issueNumber,
              null,
              { ok: false, error: error.message },
              askedByThread,
            ),
          );
      })
      .map(({ run }) => run);

  const port: FactoryPort = {
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

    async approveMerge(userId, projectId, runId, expectedSha) {
      return controlled('approve-merge', userId, projectId, runId, { expectedSha });
    },

    async approvalRequests(userId, projectId) {
      const factoryId = await settings.factoryId(userId, projectId).mapErr(settingsFailure);
      if (factoryId.isErr()) return errAsync(factoryId.error);
      if (!factoryId.value) return okAsync([]);
      const id = factoryId.value;
      return requests
        .listForFactory(id)
        .mapErr(storageFailure)
        .andThen((listed) =>
          // A pending request is brought in line with its run before it is shown.
          ResultAsync.combine(
            listed
              .filter((request) => request.state === 'pending')
              .map((request) =>
                runs
                  .get(request.runId)
                  .mapErr(storageFailure)
                  .andThen((run) => requests.sync(request.runId, run).mapErr(storageFailure)),
              ),
          ).andThen((changed) =>
            changed.some(Boolean)
              ? requests.listForFactory(id).mapErr(storageFailure)
              : okAsync(listed),
          ),
        )
        .map((listed) => listed.map(publicApprovalRequest));
    },

    async declineApprovalRequest(userId, projectId, requestId) {
      return ownFactoryOr(userId, projectId, 'Request not found').andThen((factoryId) =>
        requests
          .get(requestId)
          .mapErr(storageFailure)
          .andThen((request) =>
            request && request.factoryId === factoryId
              ? okAsync(request)
              : errAsync<never, ApiFailure>(failure(404, 'Request not found')),
          )
          .andThen((request) =>
            requests
              .resolve(request.id, 'declined', userId)
              .mapErr(storageFailure)
              .andThen((moved) => {
                if (!moved) {
                  return errAsync<never, ApiFailure>(
                    failure(409, 'This request is no longer pending.'),
                  );
                }
                audit({
                  action: 'factory.approval_declined',
                  actorId: userId,
                  detail: `Declined an agent's request to approve merging the factory run ${request.runId}`,
                  meta: { projectId, runId: request.runId, requestId, sha: request.sha },
                });
                return okAsync(publicApprovalRequest({ ...request, state: 'declined' }));
              }),
          ),
      );
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

  return {
    port,
    // The two controls an agent has. The action type leaves `approve-merge` out.
    controlled: (action, userId, projectId, runId, askedByThread) =>
      controlled(action, userId, projectId, runId, { askedByThread }),
  };
}

type ControlRun = (
  action: 'retry' | 'stop',
  userId: string,
  projectId: string,
  runId: string,
  askedByThread: string,
) => ResultAsync<FactoryRunView, ApiFailure>;

const parts = createFactoryParts();

export const factoryPort = parts.port;

/** The factory tools of the `funny` MCP server, behind the runner's data channel. */
export const factoryAgentTools = factoryAgentToolsWith(parts.controlled);
