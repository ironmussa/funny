/**
 * The run and approval-request methods of the `factory` tRPC port
 * (`factory.ts`), and a member's or an agent's control over one run.
 */

import { failure, type ApiFailure, type FactoryPort } from '@funny/api';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import {
  recordServerActivity,
  type ServerActivityOutcome,
} from '../../services/activities/server-activities.js';
import { publicApprovalRequest } from '../../services/factory/factory-approval-requests.js';
import { publicIncident } from '../../services/factory/factory-incidents.js';
import { factoryRunLabel, type FactoryRunView } from '../../services/factory/factory-runs.js';
import { setFactoryBlocked } from '../../services/factory/factory-settings.js';
import {
  controlFailure,
  reschedule,
  settingsFailure,
  storageFailure,
  type FactoryPortDeps,
  type FactoryScope,
} from './factory-port-shared.js';

export type RunControlAction = 'stop' | 'retry' | 'approve-merge';

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

/**
 * A member's control over one run (stop, retry, approve a held merge): run,
 * audited, and shown in their activities whether it worked or not
 * (track-funny-actions).
 */
export function createRunControl(
  { runs, control, requests }: FactoryPortDeps,
  { ownFactory }: FactoryScope,
) {
  return (
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
}

export type ControlledAction = ReturnType<typeof createRunControl>;

/** The settings, incident, run and approval-request methods of the port. */
export function runPortMethods(
  { settings, runs, control, incidents, requests }: FactoryPortDeps,
  { ownFactory, ownFactoryOr, configured, settingsWithIncident }: FactoryScope,
  controlled: ControlledAction,
): Pick<
  FactoryPort,
  | 'settings'
  | 'closeIncident'
  | 'save'
  | 'stopRun'
  | 'retryRun'
  | 'approveMerge'
  | 'markRunDone'
  | 'closeReplacedPr'
  | 'setLintCleanup'
  | 'approvalRequests'
  | 'declineApprovalRequest'
  | 'activeRuns'
  | 'queueRuns'
  | 'runs'
> {
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

    async approveMerge(userId, projectId, runId, expectedSha) {
      return controlled('approve-merge', userId, projectId, runId, { expectedSha });
    },

    async markRunDone(userId, projectId, runId) {
      return ownFactory(userId, projectId)
        .andThen((factoryId) => control.markDone(factoryId, runId).mapErr(controlFailure))
        .andTee((run) =>
          audit({
            action: 'factory.run_marked_done',
            actorId: userId,
            detail: `Factory run ${factoryRunLabel(run)} marked as done: no change was needed`,
            meta: { projectId, runId, issueNumber: run.issueNumber },
          }),
        );
    },

    async closeReplacedPr(userId, projectId, runId) {
      return ownFactory(userId, projectId)
        .andThen((factoryId) => control.closeReplacedPr(factoryId, runId).mapErr(controlFailure))
        .map(({ run, outcome }) => {
          audit({
            action: 'factory.superseded_pr_closed',
            actorId: userId,
            detail: `Pull request of replaced factory run ${factoryRunLabel(run)}: ${outcome.kind}`,
            meta: { projectId, runId, issueNumber: run.issueNumber, prUrl: run.prUrl },
          });
          return {
            outcome: outcome.kind,
            branchDeleted: outcome.kind === 'merged' ? false : outcome.branchDeleted,
          };
        });
    },

    async setLintCleanup(userId, projectId, runId, lintCleanup) {
      return ownFactory(userId, projectId)
        .andThen((factoryId) =>
          control.setLintCleanup(userId, factoryId, runId, lintCleanup).mapErr(controlFailure),
        )
        .andTee((run) =>
          audit({
            action: 'factory.lint_cleanup_marked',
            actorId: userId,
            detail: `Factory run ${factoryRunLabel(run)} ${lintCleanup ? 'is a lint cleanup again (veto taken back)' : 'is not a lint cleanup (triage overruled)'}`,
            meta: { projectId, runId, issueNumber: run.issueNumber, lintCleanup },
          }),
        );
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
