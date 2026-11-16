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
 * - the flow fails after an agent ran → `failed` (an attempt: the watcher
 *   re-admits the issue up to `MAX_ATTEMPTS` times);
 * - the flow fails before any agent ran (e.g. the runner is offline) → the run
 *   is dropped, not counted, and a later tick tries again;
 * - the run was stopped, or the watcher shut down → nothing more is written.
 */

import { nullReporter, runPipeline } from '@funny/pipelines';
import type { Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import type {
  StartedThread,
  StartThreadError,
  StartThreadInput,
} from '../runner-thread-launcher.js';
import { createFactoryActionProvider, type FactoryRunScope } from './factory-action-provider.js';
import { loadFactoryFlow, type FactoryFlow, type FactoryFlowError } from './factory-flow.js';
import type { FactoryGithubPort, FactoryIssue } from './factory-github.js';
import type {
  createFactoryRunsRepository,
  FactoryRunView,
  UpdateRunInput,
} from './factory-runs.js';
import type { EnabledFactory } from './factory-settings.js';
import { createThreadWaits, type ThreadOutcome } from './factory-thread-waits.js';

export interface FactoryRunJob {
  factory: EnabledFactory;
  repo: string;
  mode: 'local' | 'worktree';
  issue: FactoryIssue;
  run: FactoryRunView;
}

export interface FactoryFlowRunsDeps {
  runs: ReturnType<typeof createFactoryRunsRepository>;
  github: FactoryGithubPort;
  launch(input: StartThreadInput): Promise<Result<StartedThread, StartThreadError>>;
  waitThread?: (threadId: string, signal: AbortSignal) => Promise<ThreadOutcome>;
  loadFlow?: (job: FactoryRunJob) => Promise<Result<FactoryFlow, FactoryFlowError>>;
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

  /** Record the flow's end in the run (see the module comment). */
  async function settle(
    job: FactoryRunJob,
    outcome: 'completed' | 'failed' | 'cancelled',
    agentsRan: boolean,
    error?: string,
  ): Promise<void> {
    const { run } = job;
    if (outcome === 'cancelled') return;
    if (outcome === 'failed' && !agentsRan) {
      await deps.runs.remove(run.id);
    } else {
      const state = outcome === 'completed' ? 'waiting_human' : 'failed';
      await deps.runs.updateInFlight(run.id, { state, currentStep: null });
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
    let agentsRan = job.run.threadIds.length > 0;
    if (agentsRan) agentStarted();

    const record = async (input: UpdateRunInput): Promise<void> => {
      const live = await deps.runs.updateInFlight(job.run.id, input);
      // Stopped (or finished) elsewhere: stop driving it.
      if (live.isOk() && !live.value) controller.abort();
      if (input.threadIds) {
        agentsRan = true;
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
      launch: (body) => deps.launch({ userId: scope.userId, body }),
      waitThread,
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
          if (change.kind === 'entering') void record({ currentStep: change.nodeName });
        },
      },
    );
    // A stop or a shutdown fails the step in flight; that is not the flow failing.
    const outcome = controller.signal.aborted ? 'cancelled' : result.outcome;
    await settle(job, outcome, agentsRan, result.error);
    return agentsRan ? 'started' : 'not-started';
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

    /** Stop driving every flow (shutdown); their runs resume on the next start. */
    stopAll(): void {
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  };
}
