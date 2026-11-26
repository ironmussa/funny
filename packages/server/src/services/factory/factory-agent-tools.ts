/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * What an agent in a thread may do on the thread owner's issue factory
 * (openspec factory-agent-tools), behind the runner's data channel:
 *
 * - list the owner's runs in the thread's project,
 * - retry, stop or mark one as done, or close the pull request of a replaced
 *   run, through the same control as the board,
 * - ask the member to approve merging a held high-risk change.
 *
 * Nothing here approves a merge: there is no code path from this module to
 * `approveMerge`. The actor is always the thread's owner as stored, and the
 * project is the thread's; the agent supplies a run id and nothing else.
 */
import {
  approvalGapFor,
  type FactoryApprovalRequestState,
  type FactoryRunState,
  type FactoryWaitReason,
} from '@funny/shared/contracts/factory';
import { and, eq } from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { threads, threadShares } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { projectRole } from '../../lib/server-authorizer.js';
import { decideProjectAccess } from '../../middleware/project-access.js';
import { sandboxThreadOfRunner } from '../runner-scope.js';
import {
  createFactoryApprovalRequestsRepository,
  heldCommit,
  type FactoryApprovalRequestRecord,
} from './factory-approval-requests.js';
import { createFactoryRunsRepository, type FactoryRunView } from './factory-runs.js';
import { createFactorySettingsService } from './factory-settings.js';

/**
 * The controls an agent has: the board's, each a legal transition decided by
 * the run control, never a state the agent names. A merge approval and a
 * split (it opens issues) are not among them.
 */
export const AGENT_RUN_CONTROLS = ['retry', 'stop', 'mark-done', 'close-replaced-pr'] as const;
export type AgentRunControl = (typeof AGENT_RUN_CONTROLS)[number];

export type FactoryToolAction = 'list' | AgentRunControl | 'request-approval';

/** Whether a data-channel value names one of the agent's controls. */
export function isAgentRunControl(value: unknown): value is AgentRunControl {
  return AGENT_RUN_CONTROLS.some((control) => control === value);
}

export type FactoryToolError = {
  kind: 'refused' | 'not-found' | 'conflict' | 'storage';
  message: string;
};

/** The thread fields the access decision reads. */
export interface ToolThread {
  id: string;
  userId: string;
  projectId: string | null;
  isScratch: boolean;
  readOnly: boolean;
  runtime: string;
  source: string;
}

/**
 * Why `action` is refused from this thread, or null when it is allowed. The
 * one place the refusals of the spec are decided. The tools are for a thread
 * whose input is its owner's: not a sandbox (anything in it is readable and
 * steerable by others), not a read-only role thread, not a thread the factory
 * started (its text comes from an issue), and, for the actions that change
 * something, not a thread someone else may steer.
 */
export function factoryToolAccess(
  thread: ToolThread | null,
  action: FactoryToolAction,
  facts: { runnerOwnerId: string; sandboxRunner: boolean; steerShared: boolean },
): string | null {
  if (!thread) return 'Thread not found.';
  if (thread.userId !== facts.runnerOwnerId) return 'Thread not found.';
  if (facts.sandboxRunner || thread.runtime === 'sandbox') {
    return 'The factory tools are not available in a sandbox thread.';
  }
  if (thread.readOnly) return 'The factory tools are not available in a read-only thread.';
  if (thread.isScratch || !thread.projectId) {
    return 'The factory tools need a thread in a project.';
  }
  if (thread.source === 'factory') {
    return 'A thread the factory started cannot control the factory.';
  }
  if (action !== 'list' && facts.steerShared) {
    return 'This thread is shared for steering, so its agent can only list the factory runs. Use the factory board.';
  }
  return null;
}

/** A run as an agent sees it: state and reasons, no text written outside funny. */
export interface AgentRunSummary {
  id: string;
  issueNumber: number | null;
  prUrl: string | null;
  state: FactoryRunState;
  currentStep: string | null;
  waitReason: FactoryWaitReason | null;
  /** One line, at most 200 characters. */
  failureReason: string | null;
  risk: { level: string; headSha: string; reasons: string[]; changedLines: number | null } | null;
  /** The commit a member approved merging, or null. */
  approvedSha: string | null;
  /**
   * What changed since the commit a member approved, when the run is held
   * again on another one (openspec factory-merge-fewer-bounces, D2); else null.
   */
  sinceApproval: {
    approvedSha: string;
    lines: number | null;
    files: string[];
    moreFiles: number;
    newFiles: string[];
    newRiskKeys: string[];
  } | null;
  /** Whether it waits for a member's approval of a high-risk change. */
  awaitsApproval: boolean;
  /** Its newest approval request, or null. */
  approvalRequest: { id: string; state: FactoryApprovalRequestState; sha: string } | null;
}

/** Ended for good: shown only among the most recent runs. */
const ENDED: ReadonlySet<FactoryRunState> = new Set<FactoryRunState>(['merged', 'done', 'stopped']);
const RECENT_ENDED = 10;
const MAX_REASON = 200;

const oneLine = (text: string | null): string | null =>
  text === null ? null : text.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);

/** The held run's difference from the commit a member approved, without the free-text reason. */
function sinceApprovalOf(run: FactoryRunView): AgentRunSummary['sinceApproval'] {
  const gap = approvalGapFor(run.mergeApproval, heldCommit(run));
  if (!gap) return null;
  const { approvedSha, lines, files, moreFiles, newFiles, newRiskKeys } = gap;
  return { approvedSha, lines, files, moreFiles, newFiles, newRiskKeys };
}

function summarize(
  run: FactoryRunView,
  request: FactoryApprovalRequestRecord | undefined,
): AgentRunSummary {
  return {
    id: run.id,
    issueNumber: run.issueNumber,
    prUrl: run.prUrl,
    state: run.state,
    currentStep: run.currentStep,
    waitReason: run.waitReason,
    failureReason: oneLine(run.failureReason),
    risk: run.risk
      ? {
          level: run.risk.level,
          headSha: run.risk.headSha,
          reasons: run.risk.reasons.map((reason) => oneLine(reason) ?? ''),
          changedLines: run.risk.changedLines ?? null,
        }
      : null,
    approvedSha: run.mergeApproval?.sha ?? null,
    sinceApproval: sinceApprovalOf(run),
    awaitsApproval: heldCommit(run) !== null,
    approvalRequest: request ? { id: request.id, state: request.state, sha: request.sha } : null,
  };
}

/** The runs worth an agent's attention: everything not ended, and the last few that are. */
function relevant(runs: FactoryRunView[]): FactoryRunView[] {
  const newestFirst = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const open = newestFirst.filter((run) => !ENDED.has(run.state));
  const ended = newestFirst.filter((run) => ENDED.has(run.state)).slice(0, RECENT_ENDED);
  return [...open, ...ended];
}

export interface FactoryToolRequest {
  threadId: string;
  runnerId: string;
  /** The DB-recorded owner of the runner that asks. */
  runnerOwnerId: string;
}

type ControlRun = (
  action: AgentRunControl,
  userId: string,
  projectId: string,
  runId: string,
  threadId: string,
) => ResultAsync<FactoryRunView, { status: number; message: string }>;

export interface FactoryAgentToolsDeps {
  loadThread: (threadId: string) => Promise<ToolThread | null>;
  hasSteerShare: (threadId: string) => Promise<boolean>;
  sandboxThreadOfRunner: (runnerId: string) => Promise<string | null>;
  canSteer: (userId: string, projectId: string) => Promise<boolean>;
  factoryId: (userId: string, projectId: string) => ResultAsync<string | null, { message: string }>;
  runs: Pick<ReturnType<typeof createFactoryRunsRepository>, 'list' | 'get'>;
  requests: ReturnType<typeof createFactoryApprovalRequestsRepository>;
  /** The board's run controls (audited, in the member's activities). */
  control: ControlRun;
}

const storage = (error: { message: string }): FactoryToolError => ({
  kind: 'storage',
  message: error.message,
});
const refused = (message: string): FactoryToolError => ({ kind: 'refused', message });
const RUN_NOT_FOUND: FactoryToolError = { kind: 'not-found', message: 'Run not found.' };
const NO_STEER =
  "The thread's owner no longer has contributor access to this project, so its factory cannot be controlled.";

async function loadThreadRow(threadId: string): Promise<ToolThread | null> {
  const [row] = await db
    .select({
      id: threads.id,
      userId: threads.userId,
      projectId: threads.projectId,
      isScratch: threads.isScratch,
      readOnly: threads.readOnly,
      runtime: threads.runtime,
      source: threads.source,
    })
    .from(threads)
    .where(eq(threads.id, threadId));
  if (!row) return null;
  return {
    ...row,
    projectId: row.projectId || null,
    isScratch: Boolean(row.isScratch),
    readOnly: Boolean(row.readOnly),
  };
}

async function threadHasSteerShare(threadId: string): Promise<boolean> {
  const rows = await db
    .select({ id: threadShares.threadId })
    .from(threadShares)
    .where(and(eq(threadShares.threadId, threadId), eq(threadShares.level, 'steer')))
    .limit(1);
  return rows.length > 0;
}

export function createFactoryAgentTools(deps: FactoryAgentToolsDeps) {
  /** The thread's owner and project, once `action` is allowed from it. */
  const admitted = (
    request: FactoryToolRequest,
    action: FactoryToolAction,
  ): ResultAsync<{ userId: string; projectId: string }, FactoryToolError> =>
    ResultAsync.fromPromise(
      Promise.all([
        deps.loadThread(request.threadId),
        deps.sandboxThreadOfRunner(request.runnerId),
        deps.hasSteerShare(request.threadId),
      ]),
      (error) => storage(error instanceof Error ? error : new Error(String(error))),
    ).andThen(([thread, boundThread, steerShared]) => {
      const reason = factoryToolAccess(thread, action, {
        runnerOwnerId: request.runnerOwnerId,
        sandboxRunner: boundThread !== null,
        steerShared,
      });
      if (reason || !thread?.projectId) {
        audit({
          action: 'factory.agent_tool_refused',
          actorId: request.runnerOwnerId,
          detail: `Factory tool ${action} refused: ${reason ?? 'no project'}`,
          meta: { threadId: request.threadId, runnerId: request.runnerId, tool: action },
        });
        return errAsync<{ userId: string; projectId: string }, FactoryToolError>(
          refused(reason ?? 'The factory tools need a thread in a project.'),
        );
      }
      return okAsync({ userId: thread.userId, projectId: thread.projectId });
    });

  /** The owner's factory in the project, or null when they have none. */
  const ownFactory = (userId: string, projectId: string) =>
    deps.factoryId(userId, projectId).mapErr(storage);

  /** The run, when it belongs to the owner's factory in the thread's project. */
  const ownRun = (
    userId: string,
    projectId: string,
    runId: string,
  ): ResultAsync<{ run: FactoryRunView; factoryId: string }, FactoryToolError> =>
    ownFactory(userId, projectId).andThen((factoryId) =>
      factoryId
        ? deps.runs
            .get(runId)
            .mapErr(storage)
            .andThen((run) =>
              run && run.factoryId === factoryId
                ? okAsync({ run, factoryId })
                : errAsync<{ run: FactoryRunView; factoryId: string }, FactoryToolError>(
                    RUN_NOT_FOUND,
                  ),
            )
        : errAsync<{ run: FactoryRunView; factoryId: string }, FactoryToolError>(RUN_NOT_FOUND),
    );

  const steering = (userId: string, projectId: string): ResultAsync<true, FactoryToolError> =>
    ResultAsync.fromPromise(deps.canSteer(userId, projectId), (error) =>
      storage(error instanceof Error ? error : new Error(String(error))),
    ).andThen((can) =>
      can
        ? okAsync<true, FactoryToolError>(true)
        : errAsync<true, FactoryToolError>(refused(NO_STEER)),
    );

  return {
    /** The owner's runs in the thread's project, with each run's approval request. */
    listRuns(
      request: FactoryToolRequest,
    ): ResultAsync<{ factory: boolean; runs: AgentRunSummary[] }, FactoryToolError> {
      return admitted(request, 'list').andThen(({ userId, projectId }) =>
        ownFactory(userId, projectId).andThen((factoryId) => {
          const noRuns: AgentRunSummary[] = [];
          if (!factoryId) return okAsync({ factory: false, runs: noRuns });
          return deps.runs
            .list(factoryId)
            .mapErr(storage)
            .andThen((all) => {
              const shown = relevant(all);
              // A request is brought in line with its run before anyone reads it.
              return ResultAsync.combine(
                shown.map((run) => deps.requests.sync(run.id, run).mapErr(storage)),
              )
                .andThen(() => deps.requests.listForFactory(factoryId, 200).mapErr(storage))
                .map((requests) => {
                  // Newest first: the first one seen for a run is its latest.
                  const latest = new Map<string, FactoryApprovalRequestRecord>();
                  for (const item of requests) {
                    if (!latest.has(item.runId)) latest.set(item.runId, item);
                  }
                  return {
                    factory: true,
                    runs: shown.map((run) => summarize(run, latest.get(run.id))),
                  };
                });
            });
        }),
      );
    },

    /** Retry, stop, mark done or close a replaced PR, as the thread's owner, exactly as the board does. */
    controlRun(
      request: FactoryToolRequest,
      action: AgentRunControl,
      runId: string,
    ): ResultAsync<AgentRunSummary, FactoryToolError> {
      return admitted(request, action).andThen(({ userId, projectId }) =>
        steering(userId, projectId)
          .andThen(() => ownRun(userId, projectId, runId))
          .andThen(() =>
            deps
              .control(action, userId, projectId, runId, request.threadId)
              .mapErr<FactoryToolError>((failure) => ({
                kind: failure.status === 404 ? 'not-found' : 'conflict',
                message: failure.message,
              })),
          )
          .andThen((run) =>
            // A run that left its hold takes its pending request with it.
            deps.requests
              .sync(run.id, run)
              .mapErr(storage)
              .map(() => summarize(run, undefined)),
          ),
      );
    },

    /**
     * Ask the member to approve merging a run held as high risk. Creates (or
     * finds) the request for the held commit and returns at once. The member
     * answers in the browser; this never records an approval.
     */
    requestApproval(
      request: FactoryToolRequest,
      runId: string,
    ): ResultAsync<
      { requestId: string; sha: string; state: FactoryApprovalRequestState; created: boolean },
      FactoryToolError
    > {
      return admitted(request, 'request-approval').andThen(({ userId, projectId }) =>
        steering(userId, projectId)
          .andThen(() => ownRun(userId, projectId, runId))
          .andThen(({ run, factoryId }) => {
            const sha = heldCommit(run);
            if (!sha) {
              return errAsync<
                FactoryApprovalRequestRecord & { created: boolean },
                FactoryToolError
              >({
                kind: 'conflict',
                message: 'This run is not waiting for an approval of a high-risk change.',
              });
            }
            return deps.requests
              .ask({ runId: run.id, factoryId, projectId, threadId: request.threadId, sha })
              .mapErr(storage)
              .map(({ request: asked, created }) => {
                if (created) {
                  audit({
                    action: 'factory.approval_requested',
                    actorId: userId,
                    detail: `An agent asked to approve merging the factory run ${run.id} at ${sha}`,
                    meta: { projectId, runId: run.id, threadId: request.threadId, sha },
                  });
                  log.info('Factory merge approval requested by an agent', {
                    namespace: 'factory',
                    runId: run.id,
                    threadId: request.threadId,
                    sha,
                  });
                }
                return { ...asked, created };
              });
          })
          .map((asked) => ({
            requestId: asked.id,
            sha: asked.sha,
            state: asked.state,
            created: asked.created,
          })),
      );
    },
  };
}

export type FactoryAgentTools = ReturnType<typeof createFactoryAgentTools>;

/** The production wiring, given the board's control (it lives with the tRPC port). */
export function factoryAgentToolsWith(control: ControlRun): FactoryAgentTools {
  const settings = createFactorySettingsService();
  return createFactoryAgentTools({
    loadThread: loadThreadRow,
    hasSteerShare: threadHasSteerShare,
    sandboxThreadOfRunner,
    canSteer: async (userId, projectId) =>
      (await decideProjectAccess(projectRole, 'steer', projectId, userId)) === null,
    factoryId: (userId, projectId) => settings.factoryId(userId, projectId),
    runs: createFactoryRunsRepository(),
    requests: createFactoryApprovalRequestsRepository(),
    control,
  });
}
