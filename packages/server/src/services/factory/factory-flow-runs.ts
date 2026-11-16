/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * Runs a factory run's flow on the server as the factory's enabler (change
 * factory-flow-execution, task 3.2): the compiled flow (`factory-flow.ts`)
 * through `@funny/pipelines` with the factory's server provider, its progress
 * written to `factory_runs` (`currentStep`, `threadIds`, the PR, the state).
 *
 * A run's flow lives in this process while its threads run. After a restart
 * (or a launch interrupted by one) the watcher starts it again: the provider
 * replays the agent steps whose threads are recorded, so no work is started
 * twice and a finished thread is not waited on again.
 *
 * How a run ends:
 * - the flow completes → `waiting_human`, unless it merged (`merged`);
 * - the flow fails once its pull request is open (e.g. CI still red after
 *   the fixes the flow allows) → `waiting_human` at the failed step: the work
 *   is on GitHub for the member to take over or retry, and they are notified;
 * - the flow fails before that, after an agent ran → `failed` (an attempt: the
 *   watcher re-admits the issue up to `MAX_ATTEMPTS` times);
 * - the flow fails before any agent ran (e.g. the runner is offline) → the run
 *   is dropped, not counted, and a later tick tries again;
 * - the run was stopped, or the watcher shut down → nothing more is written.
 */

import { nullReporter, runPipeline } from '@funny/pipelines';
import { and, asc, eq, gte } from 'drizzle-orm';
import type { Result } from 'neverthrow';

import { db } from '../../db/index.js';
import { messages, threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import type {
  StartedThread,
  StartThreadError,
  StartThreadInput,
} from '../runner-thread-launcher.js';
import { sendPush } from '../web-push.js';
import { createFactoryActionProvider, type FactoryRunScope } from './factory-action-provider.js';
import { loadFactoryFlow, type FactoryFlow, type FactoryFlowError } from './factory-flow.js';
import type { FactoryGithubPort, FactoryIssue } from './factory-github.js';
import type {
  createFactoryRunsRepository,
  FactoryRunView,
  UpdateRunInput,
} from './factory-runs.js';
import type { WatchedFactory } from './factory-settings.js';
import { createThreadWaits, type ThreadOutcome, type WaitAfter } from './factory-thread-waits.js';

export interface FactoryRunJob {
  factory: WatchedFactory;
  repo: string;
  mode: 'local' | 'worktree';
  issue: FactoryIssue;
  run: FactoryRunView;
}

export interface FactoryFlowRunsDeps {
  runs: ReturnType<typeof createFactoryRunsRepository>;
  github: FactoryGithubPort;
  launch(input: StartThreadInput): Promise<Result<StartedThread, StartThreadError>>;
  waitThread?: (threadId: string, signal: AbortSignal, after?: WaitAfter) => Promise<ThreadOutcome>;
  /**
   * Send a follow-up to the enabler's thread, so later agent steps continue
   * the first one; without it each agent step starts a new thread.
   */
  followUp?: (userId: string, threadId: string, content: string) => Promise<Result<void, string>>;
  loadFlow?: (job: FactoryRunJob) => Promise<Result<FactoryFlow, FactoryFlowError>>;
  /** Tell the enabler a run waits for them; defaults to Web Push. */
  notify?: (userId: string, message: WaitingNotice) => Promise<unknown>;
}

export interface WaitingNotice {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** What the flow left behind when it ended, for `settle`. */
interface FlowTrace {
  agentsRan: boolean;
  prOpen: boolean;
  /** The last step the flow entered. */
  step: string | null;
}

/** Allowance for the runner's clock being behind the server's when matching a launch. */
const LAUNCH_CLOCK_SLACK_MS = 60 * 1000;

const slackBefore = (since: string) =>
  new Date(Date.parse(since) - LAUNCH_CLOCK_SLACK_MS).toISOString();

async function threadCompletedAt(threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ completedAt: threads.completedAt })
    .from(threads)
    .where(eq(threads.id, threadId));
  return row?.completedAt ?? null;
}

/** A user message on the thread since `since`: an interrupted follow-up reached it. */
async function followedUpSince(threadId: string, since: string): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(messages.role, 'user'),
        gte(messages.timestamp, slackBefore(since)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The factory thread an interrupted launch started: the enabler's, in the
 * project, with the step's title, created since the launch began. One run per
 * issue is in flight and its steps run one at a time, so the title and the time
 * identify it.
 */
async function findLaunchedThread(
  scope: { userId: string; projectId: string },
  title: string,
  since: string,
): Promise<string | null> {
  const after = slackBefore(since);
  const [row] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.userId, scope.userId),
        eq(threads.projectId, scope.projectId),
        eq(threads.source, 'factory'),
        eq(threads.title, title),
        gte(threads.createdAt, after),
      ),
    )
    .orderBy(asc(threads.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** Whether a started run has an agent working (or is done), or never started one. */
export type FactoryRunStart = 'started' | 'not-started';

/** The branch a run's agent pushes and opens its pull request from. */
const runBranch = (run: FactoryRunView): string =>
  `factory/issue-${run.issueNumber}-${run.id.slice(0, 8)}`;

export function createFactoryFlowRuns(deps: FactoryFlowRunsDeps) {
  const active = new Map<string, AbortController>();
  const waitThread = deps.waitThread ?? createThreadWaits();

  const loadFlow =
    deps.loadFlow ??
    ((job: FactoryRunJob) =>
      loadFactoryFlow(job.factory.flowName, {
        readDefaultBranchFile: (path) =>
          deps.github.readDefaultBranchFile(
            { repo: job.repo, ownerId: job.factory.userId, projectId: job.factory.projectId },
            path,
          ),
      }));

  /** A run whose flow could not be loaded: dropped when it never ran, failed when invalid. */
  async function flowUnavailable(job: FactoryRunJob, error: FactoryFlowError): Promise<void> {
    log.warn('Issue factory flow could not be loaded', {
      namespace: 'factory',
      factoryId: job.factory.id,
      runId: job.run.id,
      flow: job.factory.flowName,
      kind: error.kind,
      error: error.message,
    });
    if (error.kind === 'invalid') {
      await deps.runs.updateInFlight(job.run.id, { state: 'failed', currentStep: null });
    } else if (job.run.threadIds.length === 0) {
      await deps.runs.remove(job.run.id);
    }
  }

  const notify = deps.notify ?? sendPush;

  /** Tell the enabler their run waits for them; best-effort. */
  async function noticeWaiting(job: FactoryRunJob, why: string): Promise<void> {
    await notify(job.factory.userId, {
      title: `Issue #${job.issue.number} needs you`,
      body: why.length > 200 ? `${why.slice(0, 199)}…` : why,
      url: `/projects/${job.factory.projectId}`,
      tag: `factory-run-${job.run.id}`,
    }).catch((error: unknown) =>
      log.warn('Issue factory notification failed', {
        namespace: 'factory',
        runId: job.run.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /**
   * Leave the run for the member — completed without a merge, or failed (at
   * `failedStep`) with its pull request open — and tell them.
   */
  async function park(job: FactoryRunJob, failedStep: string | null, error?: string) {
    const parked = await deps.runs.updateInFlight(job.run.id, {
      state: 'waiting_human',
      currentStep: failedStep,
    });
    if (parked.isErr() || !parked.value) return;
    const why = failedStep
      ? `The ${failedStep} step failed: ${error ?? ''}`.trim()
      : 'Its pull request is ready.';
    await noticeWaiting(job, why);
  }

  /** Record the flow's end in the run (see the module comment). */
  async function settle(
    job: FactoryRunJob,
    outcome: 'completed' | 'failed' | 'cancelled',
    trace: FlowTrace,
    error?: string,
  ): Promise<void> {
    const { run } = job;
    if (outcome === 'cancelled') return;
    if (outcome === 'failed' && !trace.agentsRan) {
      await deps.runs.remove(run.id);
    } else if (outcome === 'failed' && !trace.prOpen) {
      await deps.runs.updateInFlight(run.id, { state: 'failed', currentStep: trace.step });
    } else {
      await park(job, outcome === 'failed' ? trace.step : null, error);
    }
    log.info('Issue factory run ended', {
      namespace: 'factory',
      factoryId: job.factory.id,
      runId: run.id,
      issue: run.issueNumber,
      outcome,
      error,
    });
  }

  async function execute(
    job: FactoryRunJob,
    controller: AbortController,
    agentStarted: () => void,
  ): Promise<FactoryRunStart> {
    const flow = await loadFlow(job);
    if (flow.isErr()) {
      await flowUnavailable(job, flow.error);
      return 'not-started';
    }
    const trace: FlowTrace = {
      agentsRan: job.run.threadIds.length > 0,
      prOpen: job.run.prUrl !== null,
      step: null,
    };
    if (trace.agentsRan) agentStarted();

    const record = async (input: UpdateRunInput): Promise<void> => {
      const live = await deps.runs.updateInFlight(job.run.id, input);
      // Stopped (or finished) elsewhere: stop driving it.
      if (live.isOk() && !live.value) controller.abort();
      if (input.prUrl) trace.prOpen = true;
      if (input.threadIds) {
        trace.agentsRan = true;
        agentStarted();
      }
    };

    const scope: FactoryRunScope = {
      runId: job.run.id,
      userId: job.factory.userId,
      projectId: job.factory.projectId,
      repo: job.repo,
      mode: job.mode,
      issueNumber: job.issue.number,
      issueTitle: job.issue.title,
      branch: runBranch(job.run),
    };
    const provider = createFactoryActionProvider({
      scope,
      threadIds: job.run.threadIds,
      prUrl: job.run.prUrl,
      launchStartedAt: job.run.launchStartedAt,
      findLaunched: (title, since) => findLaunchedThread(scope, title, since),
      launch: (body) => deps.launch({ userId: scope.userId, body }),
      waitThread,
      continuation: deps.followUp
        ? {
            followUp: (threadId, content) => deps.followUp!(scope.userId, threadId, content),
            completedAt: threadCompletedAt,
            followedUpSince,
          }
        : undefined,
      github: deps.github,
      record,
      signal: controller.signal,
    });

    const result = await runPipeline(
      flow.value.pipeline,
      {
        provider,
        progress: nullReporter,
        cwd: '',
        inputs: {
          repo: job.repo,
          issue_number: String(job.issue.number),
          issue_title: job.issue.title,
          issue_url: job.issue.url,
          branch: scope.branch,
        },
        outputs: {},
      },
      {
        signal: controller.signal,
        onStateChange: (change) => {
          if (change.kind !== 'entering') return;
          trace.step = change.nodeName;
          void record({ currentStep: change.nodeName });
        },
      },
    );
    // A stop or a shutdown fails the step in flight; that is not the flow failing.
    const outcome = controller.signal.aborted ? 'cancelled' : result.outcome;
    await settle(job, outcome, trace, result.error);
    return trace.agentsRan ? 'started' : 'not-started';
  }

  return {
    /**
     * Run (or resume) a run's flow. Resolves once its first agent thread is
     * recorded — the run holds a slot — or the flow ended without one; the
     * flow itself goes on in the background.
     */
    start(job: FactoryRunJob): Promise<FactoryRunStart> {
      if (active.has(job.run.id)) return Promise.resolve('started');
      const controller = new AbortController();
      active.set(job.run.id, controller);
      let ready!: (start: FactoryRunStart) => void;
      const started = new Promise<FactoryRunStart>((resolve) => (ready = resolve));
      execute(job, controller, () => ready('started'))
        .then(ready, (error: unknown) => {
          log.error('Issue factory flow crashed', {
            namespace: 'factory',
            runId: job.run.id,
            error: error instanceof Error ? error.message : String(error),
          });
          ready('not-started');
        })
        .finally(() => {
          if (active.get(job.run.id) === controller) active.delete(job.run.id);
        });
      return started;
    },

    isActive: (runId: string) => active.has(runId),

    /** Stop driving one run's flow (the run was stopped); nothing more is written for it. */
    stop(runId: string): void {
      active.get(runId)?.abort();
      active.delete(runId);
    },

    /** Stop driving every flow (shutdown); their runs resume on the next start. */
    stopAll(): void {
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  };
}
