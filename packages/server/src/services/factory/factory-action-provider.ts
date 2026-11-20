/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * The factory's server `ActionProvider` (change factory-flow-execution, task
 * 3.1): how a flow's steps act when the server runs them as the factory's
 * enabler.
 *
 * - `spawn_agent` starts a thread on the enabler's runner (the caller's
 *   `launch`, i.e. `startThreadOnRunner`, so runner isolation and the
 *   project ↔ runner binding apply) and resolves from the thread's durable
 *   terminal status. Agent steps are numbered in call order: a resumed run
 *   (after a server restart) re-runs the flow, and the N-th agent step finds
 *   the thread it already started instead of starting another; a flow's control
 *   flow depends only on step results, so the order is the same.
 * - Every agent step after the first CONTINUES the run's first thread with a
 *   follow-up message (when `continuation` is given), so a CI fix keeps the
 *   context of the implementation instead of starting cold. Such a step is
 *   recorded under the same thread id again.
 * - `git_commit` / `git_push` are acknowledged: the server has no checkout, the
 *   agent commits and pushes on the runner. `create_pr` finds the pull request
 *   the agent opened from the run's branch.
 * - `wait_ci` / `merge` act on that pull request with the App token capped by
 *   the enabler (`factory-ci-actions.ts`).
 * - `run_command`, `set_status`, `set_stage` and approvals are refused: there
 *   is nowhere on the server to run them (checks belong in the repository's CI).
 */

import type {
  ActionProvider,
  ActionResult,
  ApprovalDecision,
  SpawnAgentOpts,
} from '@funny/workflows/compiler';
import type { Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import type { StartedThread, StartThreadError } from '../runner-thread-launcher.js';
import { createFactoryCiActions } from './factory-ci-actions.js';
import type { FactoryGithubPort } from './factory-github.js';
import { prNumberOf, type FactoryPullRequestRef } from './factory-pull-requests.js';
import type { UpdateRunInput } from './factory-runs.js';
import type { ThreadOutcome, WaitAfter } from './factory-thread-waits.js';

/** Where the run's agent threads run: the enabler's runtime for the project. */
export type FactoryThreadMode = 'local' | 'worktree' | 'sandbox';

/** Everything a run's steps are bound to. */
export interface FactoryRunScope {
  runId: string;
  /** The factory's enabler: every thread and token is theirs. */
  userId: string;
  projectId: string;
  /** `owner/name`. */
  repo: string;
  mode: FactoryThreadMode;
  issueNumber: number;
  issueTitle: string;
  /** The branch the agent pushes and opens the pull request from. */
  branch: string;
}

export interface FactoryActionProviderDeps {
  scope: FactoryRunScope;
  /** Thread ids the run's agent steps already started, in order (a resumed run). */
  threadIds: string[];
  /** The run's pull request, when an earlier attempt found it. */
  prUrl: string | null;
  /**
   * Set when the run was interrupted while starting its next agent thread:
   * that step first looks for the thread it may have started.
   */
  launchStartedAt: string | null;
  /**
   * A factory thread of the enabler whose title starts with `titlePrefix`
   * (`[Factory] #N `, stable even if the issue is renamed) created since
   * `since`, if any.
   */
  findLaunched(titlePrefix: string, since: string): Promise<string | null>;
  /** Stop a thread this run started after it was stopped (a launch racing the stop). */
  abandon?(threadId: string): Promise<void>;
  /** Start a thread on the enabler's runner (`startThreadOnRunner` for the enabler). */
  launch(body: Record<string, unknown>): Promise<Result<StartedThread, StartThreadError>>;
  /** Resolves with the thread's terminal status (or why it never will reach one). */
  waitThread(threadId: string, signal: AbortSignal, after?: WaitAfter): Promise<ThreadOutcome>;
  /** Continue the first thread for later agent steps; without it each step starts a thread. */
  continuation?: FactoryContinuation;
  github: Pick<FactoryGithubPort, 'findPullRequest' | 'pullRequests'>;
  /** Write the run's progress; ignored once the run is terminal (e.g. stopped). */
  record(input: UpdateRunInput): Promise<void>;
  signal: AbortSignal;
}

/** Following up on a run's thread, as the enabler. */
export interface FactoryContinuation {
  followUp(threadId: string, content: string): Promise<Result<void, string>>;
  /** The thread's `completedAt` now (before a follow-up runs it again). */
  completedAt(threadId: string): Promise<string | null>;
  /** Whether a member/user message reached the thread since `since` (an interrupted follow-up). */
  followedUpSince(threadId: string, since: string): Promise<boolean>;
}

/** The thread an agent step waits on; `after` when a follow-up runs it again. */
interface StepThread {
  threadId: string;
  after?: WaitAfter;
  /** A step recorded before a resume, retry or take-over. */
  replayed?: boolean;
}

/** Allowance for the runner's clock when comparing its timestamps with the server's. */
const CLOCK_SLACK_MS = 60 * 1000;

const refused = (step: string, why: string): ActionResult => ({
  ok: false,
  error: `${step} is not available in a factory flow: ${why}`,
});

function prompted(opts: SpawnAgentOpts): string {
  return opts.context
    ? `${opts.prompt}\n\nContext from previous step:\n${opts.context}`
    : opts.prompt;
}

function outcomeResult(threadId: string, outcome: ThreadOutcome): ActionResult {
  if (outcome.status === 'completed') {
    return { ok: true, output: outcome.output, metadata: { threadId } };
  }
  return {
    ok: false,
    error: outcome.reason ?? `The agent thread ended ${outcome.status}.`,
    metadata: { threadId, status: outcome.status },
  };
}

export function createFactoryActionProvider(deps: FactoryActionProviderDeps): ActionProvider {
  const { scope } = deps;
  const threadIds = [...deps.threadIds];
  let agentSteps = 0;
  let prUrl = deps.prUrl;
  let pendingLaunch = deps.launchStartedAt;
  const titlePrefix = `[Factory] #${scope.issueNumber} `;
  const title = `${titlePrefix}${scope.issueTitle}`.slice(0, 200);

  const pullRequest = (): FactoryPullRequestRef | null => {
    const number = prNumberOf(prUrl);
    if (number === null) return null;
    return {
      repo: scope.repo,
      number,
      branch: scope.branch,
      userId: scope.userId,
      projectId: scope.projectId,
    };
  };

  const ci = createFactoryCiActions({
    prs: deps.github.pullRequests,
    pullRequest,
    signal: deps.signal,
    markMerged: () => deps.record({ state: 'merged', currentStep: null }),
  });

  /** Record the step's thread; the launch marker is cleared in the same write. */
  async function recordThread(threadId: string): Promise<string> {
    threadIds.push(threadId);
    // A fix after the pull request is open is a `fixing` step, not new work.
    await deps.record({
      state: prUrl ? 'fixing' : 'working',
      threadIds: [...threadIds],
      launchStartedAt: null,
    });
    // Stopped while the launch was in flight: the stop missed this thread.
    if (deps.signal.aborted) await deps.abandon?.(threadId);
    return threadId;
  }

  /** The thread an interrupted launch of this step started, if it got that far. */
  async function adoptInterrupted(step: number): Promise<string | null> {
    const since = pendingLaunch;
    pendingLaunch = null;
    if (!since || step !== threadIds.length) return null;
    const found = await deps.findLaunched(titlePrefix, since);
    return found && !threadIds.includes(found) ? found : null;
  }

  /** Continue the run's first thread with this step's prompt (a later agent step). */
  async function followUp(
    continuation: FactoryContinuation,
    first: string,
    opts: SpawnAgentOpts,
  ): Promise<StepThread | ActionResult> {
    const since = pendingLaunch;
    pendingLaunch = null;
    if (since && (await continuation.followedUpSince(first, since))) {
      // Sent before an interruption: wait for that run, do not send it twice.
      return {
        threadId: await recordThread(first),
        after: await interruptedAfter(continuation, first, since),
      };
    }
    const before = await continuation.completedAt(first);
    const sentAt = new Date().toISOString();
    await deps.record({ launchStartedAt: sentAt });
    const sent = await continuation.followUp(first, prompted(opts));
    if (sent.isErr()) {
      await deps.record({ launchStartedAt: null });
      return { ok: false, error: `The agent could not continue: ${sent.error}` };
    }
    return { threadId: await recordThread(first), after: { completedAt: before, sentAt } };
  }

  /**
   * What an adopted (interrupted) follow-up waits for: when the thread last
   * finished before the follow-up was sent, the follow-up's own run has not
   * finished yet, so wait for `completedAt` to change.
   */
  async function interruptedAfter(
    continuation: FactoryContinuation,
    threadId: string,
    since: string,
  ): Promise<WaitAfter | undefined> {
    const current = await continuation.completedAt(threadId);
    const finishedBefore =
      current !== null && Date.parse(current) < Date.parse(since) - CLOCK_SLACK_MS;
    return finishedBefore ? { completedAt: current, sentAt: since } : undefined;
  }

  /** Start a new thread for this step, marked first so a crash in between is adopted. */
  async function launchNew(opts: SpawnAgentOpts): Promise<StepThread | ActionResult> {
    await deps.record({ launchStartedAt: new Date().toISOString() });
    const launched = await deps.launch({
      projectId: scope.projectId,
      title,
      mode: scope.mode,
      source: 'factory',
      prompt: prompted(opts),
      model: opts.model ?? undefined,
    });
    const threadId = launched.isOk() ? launched.value.threadId : undefined;
    if (threadId) return { threadId: await recordThread(threadId) };
    await deps.record({ launchStartedAt: null });
    return {
      ok: false,
      error: launched.isErr()
        ? `The agent could not start: ${launched.error.message}`
        : 'The agent could not start: the runner returned no thread.',
    };
  }

  /** The thread of the current agent step: recorded, continued, adopted, or new. */
  async function threadFor(opts: SpawnAgentOpts, step: number): Promise<StepThread | ActionResult> {
    const recorded = threadIds[step];
    if (recorded) return { threadId: recorded, replayed: true };
    const first = threadIds[0];
    if (step > 0 && first && deps.continuation) return followUp(deps.continuation, first, opts);
    const adopted = await adoptInterrupted(step);
    return adopted ? { threadId: await recordThread(adopted) } : launchNew(opts);
  }

  return {
    async spawnAgent(opts) {
      const index = agentSteps++;
      const step = await threadFor(opts, index);
      if (!('threadId' in step)) return step;
      // A replayed step that a LATER recorded step continued on the same thread
      // finished before that one started: waiting on the thread now would read
      // the later step's run instead of this one.
      if (step.replayed && threadIds.slice(index + 1).includes(step.threadId)) {
        return { ok: true, output: '', metadata: { threadId: step.threadId, replayed: true } };
      }
      return outcomeResult(
        step.threadId,
        await deps.waitThread(step.threadId, deps.signal, step.after),
      );
    },

    async gitCommit() {
      return { ok: true, output: 'The agent commits on the runner.' };
    },

    async gitPush() {
      return { ok: true, output: 'The agent pushes on the runner.' };
    },

    async createPr() {
      const found = await deps.github.findPullRequest(
        { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId },
        scope.branch,
      );
      if (found.isErr()) return { ok: false, error: found.error.message };
      if (!found.value) {
        return {
          ok: false,
          error: `No open pull request from the branch ${scope.branch}: the agent did not open one.`,
        };
      }
      prUrl = found.value.url;
      await deps.record({ state: 'pr_open', prUrl });
      return { ok: true, output: prUrl, metadata: { number: found.value.number } };
    },

    async waitCi(opts) {
      await deps.record({ state: 'waiting_ci' });
      return ci.waitCi(opts);
    },

    merge: (opts) => ci.merge(opts),

    async notify(opts) {
      log.info('Issue factory flow notice', {
        namespace: 'factory',
        runId: scope.runId,
        level: opts.level ?? 'info',
        message: opts.message,
      });
      return { ok: true };
    },

    async runCommand() {
      return refused('run_command', 'the server has no checkout; run checks in CI (wait_ci).');
    },

    async setStatus() {
      return refused('set_status', 'the run has no thread of its own.');
    },

    async setStage() {
      return refused('set_stage', 'the run has no thread of its own.');
    },

    async requestApproval(): Promise<ApprovalDecision> {
      return { decision: 'reject', reason: 'Approvals are not available in a factory flow.' };
    },
  };
}
