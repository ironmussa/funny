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
import type { FactoryPullRequestRef } from './factory-pull-requests.js';
import type { UpdateRunInput } from './factory-runs.js';
import type { ThreadOutcome } from './factory-thread-waits.js';

/** Everything a run's steps are bound to. */
export interface FactoryRunScope {
  runId: string;
  /** The factory's enabler: every thread and token is theirs. */
  userId: string;
  projectId: string;
  /** `owner/name`. */
  repo: string;
  mode: 'local' | 'worktree';
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
  /** Start a thread on the enabler's runner (`startThreadOnRunner` for the enabler). */
  launch(body: Record<string, unknown>): Promise<Result<StartedThread, StartThreadError>>;
  /** Resolves with the thread's terminal status (or why it never will reach one). */
  waitThread(threadId: string, signal: AbortSignal): Promise<ThreadOutcome>;
  github: Pick<FactoryGithubPort, 'findPullRequest' | 'pullRequests'>;
  /** Write the run's progress; ignored once the run is terminal (e.g. stopped). */
  record(input: UpdateRunInput): Promise<void>;
  signal: AbortSignal;
}

const PR_NUMBER = /\/pull\/(\d+)(?:$|[/?#])/;

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

  const pullRequest = (): FactoryPullRequestRef | null => {
    const number = prUrl ? Number(PR_NUMBER.exec(prUrl)?.[1]) : NaN;
    if (!Number.isInteger(number)) return null;
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

  /** The thread of the current agent step: the recorded one, or a new one. */
  async function threadFor(opts: SpawnAgentOpts, step: number): Promise<string | ActionResult> {
    const recorded = threadIds[step];
    if (recorded) return recorded;
    const launched = await deps.launch({
      projectId: scope.projectId,
      title: `[Factory] #${scope.issueNumber} ${scope.issueTitle}`.slice(0, 200),
      mode: scope.mode,
      source: 'factory',
      prompt: prompted(opts),
      ...(opts.model ? { model: opts.model } : {}),
    });
    const threadId = launched.isOk() ? launched.value.threadId : undefined;
    if (!threadId) {
      return {
        ok: false,
        error: launched.isErr()
          ? `The agent could not start: ${launched.error.message}`
          : 'The agent could not start: the runner returned no thread.',
      };
    }
    threadIds.push(threadId);
    // A fix after the pull request is open is a `fixing` step, not new work.
    await deps.record({ state: prUrl ? 'fixing' : 'working', threadIds: [...threadIds] });
    return threadId;
  }

  return {
    async spawnAgent(opts) {
      const thread = await threadFor(opts, agentSteps++);
      if (typeof thread !== 'string') return thread;
      return outcomeResult(thread, await deps.waitThread(thread, deps.signal));
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
