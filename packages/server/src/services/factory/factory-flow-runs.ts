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
 * (or a launch interrupted by one) the watcher starts it again, and no work is
 * started twice nor a finished thread waited on again: the engine's journal
 * (`workflow_node_executions`, change workflow-dag-engine) replays the steps
 * that finished and hands an unfinished one what it checkpointed. A run
 * without journal rows (from before the journal, or reopened by a retry or a
 * take-over) replays its recorded threads by call order instead, once.
 *
 * How a run ends:
 * - the flow completes → `waiting_human`, unless it merged (`merged`);
 * - the flow fails once its pull request is open (e.g. CI still red after
 *   the fixes the flow allows) → `waiting_human` at the failed step: the work
 *   is on GitHub for the member to take over or retry, and they are notified;
 * - the flow fails before that, after an agent ran → `failed` (an attempt: the
 *   watcher re-admits the issue up to `MAX_ATTEMPTS` times);
 * - the flow fails before any agent ran (e.g. the runner is offline) → a
 *   label run is dropped, not counted, and a later tick tries again; a sent
 *   issue goes back to the queue (`requested`) in its place, so the request
 *   is not lost;
 * - the run was stopped, or the watcher shut down → nothing more is written.
 */

import { nullReporter, runPipeline } from '@funny/pipelines';
import type { YamlPipelineContext } from '@funny/workflows/compiler';

import { log } from '../../lib/logger.js';
import {
  createWorkflowJournalRepository,
  databaseJournal,
} from '../workflow-engine/journal-repository.js';
import type { EarlyIntegration, EarlyOutcome } from './factory-early-integration.js';
import {
  blocksOthers,
  createRunProvider,
  scopeOf,
  type FlowRunsContext,
  type MergeOrder,
} from './factory-flow-runs-provider.js';
import { createRunSettlement } from './factory-flow-runs-settle.js';
import {
  admissionPriority,
  flowGate,
  flowInputsOf,
  flowOf,
  journalCodec,
  logFlowWarnings,
  mergePriority,
  traceRecorded,
  wasReopened,
  type FactoryFlowRunsDeps,
  type FactoryRunJob,
  type FactoryRunStart,
  type FlowTrace,
} from './factory-flow-runs-support.js';
import {
  isMergeLane,
  flowReadsOf,
  loadFactoryFlow,
  type FactoryFlowContext,
} from './factory-flow.js';
import type { UpdateRunInput } from './factory-runs.js';
import { projectAgentDefaults, type WatchedFactory } from './factory-settings.js';
import { createThreadWaits } from './factory-thread-waits.js';

export {
  admissionPriority,
  flowInputsOf,
  mergePriority,
  type FactoryFlowRunsDeps,
  type FactoryRunJob,
  type FactoryRunStart,
  type WaitingNotice,
} from './factory-flow-runs-support.js';

export function createFactoryFlowRuns(deps: FactoryFlowRunsDeps) {
  const active = new Map<string, AbortController>();
  /** Each running flow's early integration (D8), for the watcher to ask when the base moves. */
  const earlyOf = new Map<string, EarlyIntegration>();
  const waitThread = deps.waitThread ?? createThreadWaits();
  const journalRows = createWorkflowJournalRepository();
  /** Each run's place in a group's queue, by its id (the holder is `<runId>/<node>/<visit>`). */
  const priorities = new Map<string, number>();
  /** What orders a run in the merge group: whether it blocks other runs, and its size. */
  const mergeOrder = new Map<string, MergeOrder>();
  const priorityOf = (holder: string): number => {
    const [runId = '', node] = holder.split('/');
    const admission = priorities.get(runId) ?? 0;
    const order = mergeOrder.get(runId);
    return node === 'merge' && order ? mergePriority(admission, order) : admission;
  };
  /** Each factory's own stage limits, by its id: what replaces a flow's declared limit. */
  const stageLimits = new Map<string, Record<string, number>>();
  /** The factory's limit for a stage group (`<node>:<factoryId>`), when it set one. */
  const stageLimitOf = (group: string): number | undefined => {
    const at = group.lastIndexOf(':');
    return at < 0 ? undefined : stageLimits.get(group.slice(at + 1))?.[group.slice(0, at)];
  };
  const { gate, stop: stopGate } = flowGate(deps.gate, {
    // The merge lane is one at a time, whatever a flow or a setting says.
    resolveLimit: (group, declared) => (isMergeLane(group) ? 1 : (stageLimitOf(group) ?? declared)),
    priority: priorityOf,
  });

  const loadFlow =
    deps.loadFlow ??
    ((job: FactoryRunJob, context: FactoryFlowContext) =>
      loadFactoryFlow(
        flowOf(job),
        flowReadsOf(deps.github, {
          repo: job.repo,
          ownerId: job.factory.userId,
          projectId: job.factory.projectId,
        }),
        context,
      ));

  /**
   * Keep the issue's title on the run as the flow read it, so the board names
   * a run with no thread by its issue. A failed write only costs that name.
   */
  async function recordIssueTitle(job: FactoryRunJob): Promise<void> {
    const title = job.issue?.title;
    if (!title || title === job.run.issueTitle) return;
    const written = await deps.runs.update(job.run.id, { issueTitle: title });
    if (written.isErr()) {
      log.warn('Issue factory could not record the issue title of a run', {
        namespace: 'factory',
        runId: job.run.id,
        error: written.error.message,
      });
    }
  }

  const settlement = createRunSettlement(deps);
  const { updateInFlight, flowUnavailable, cleanUpMerged, settle, refusedWithoutIssue } =
    settlement;
  const ctx: FlowRunsContext = { deps, updateInFlight, earlyOf, mergeOrder, gate, waitThread };

  async function execute(
    job: FactoryRunJob,
    controller: AbortController,
    agentStarted: () => void,
  ): Promise<FactoryRunStart> {
    await recordIssueTitle(job);
    const projectDefaults = await projectAgentDefaults(job.factory.projectId);
    const flow = await loadFlow(job, {
      project: projectDefaults,
      overrides: job.factory.stepOverrides,
      batch: job.factory.batch,
      dependencies: job.factory.dependencies,
    });
    if (flow.isErr()) {
      await flowUnavailable(job, flow.error);
      return 'not-started';
    }
    logFlowWarnings(job, flow.value);
    if (await refusedWithoutIssue(job, flow.value)) return 'not-started';
    priorities.set(job.run.id, admissionPriority(job.run));
    mergeOrder.set(job.run.id, { blocker: await blocksOthers(deps, job) });
    stageLimits.set(job.factory.id, job.factory.stageLimits);
    const trace: FlowTrace = {
      agentsRan: job.run.threadIds.length > 0,
      prOpen: job.run.prUrl !== null,
      held: false,
      step: null,
      parked: false,
      ended: false,
    };
    if (trace.agentsRan) agentStarted();

    const record = async (input: UpdateRunInput): Promise<void> => {
      // A stopped flow writes nothing more: its run may already be retried.
      if (controller.signal.aborted) return;
      const live = await updateInFlight(job.run.id, input);
      // Stopped (or finished) elsewhere: stop driving it.
      if (live.isOk() && !live.value) controller.abort();
      if (live.isOk() && live.value && input.state === 'merged') cleanUpMerged(job);
      // The tick that admitted the run waits for its implementing thread, so a
      // launch that fails frees its slot in the same tick. While triage runs
      // first that wait ends at the watcher's own limit (`ADMIT_WAIT_MS`).
      if (traceRecorded(trace, input)) agentStarted();
    };

    // The thread view draws the run's step chain from these.
    await record({ flowSteps: flow.value.pipeline.nodes.map((node) => node.name) });
    // Where the flow came from: written when the run first starts and on a
    // retry (it runs the flow as read now); a resumed run keeps what it had.
    if (job.run.flowSource === null || wasReopened(job)) {
      await record({ flowSource: flow.value.source, flowCommit: flow.value.commit });
    }
    // What each agent step ran with, after the steps an earlier attempt recorded.
    const stepOptions = [...job.run.stepOptions];

    // A run with journal rows resumes through them; one without replays `threadIds`.
    const journaled = await journalRows.load(job.run.id);
    if (journaled.isErr()) {
      log.warn('Issue factory run journal could not be read', {
        namespace: 'factory',
        runId: job.run.id,
        error: journaled.error.message,
      });
      return trace.agentsRan ? 'started' : 'not-started';
    }

    const scope = scopeOf(job);
    const provider = createRunProvider(ctx, {
      job,
      scope,
      controller,
      trace,
      flow: flow.value,
      projectDefaults,
      stepOptions,
      record,
      legacyReplay: journaled.value.length === 0,
    });

    // The branch the pull request merges into names the merge lane. Unknown
    // (GitHub could not be read): the lane is the repository's, which still
    // merges one at a time.
    const base = await deps.github.defaultBranch({
      repo: scope.repo,
      ownerId: scope.userId,
      projectId: scope.projectId,
    });
    const baseBranch = base.isOk() ? base.value : '';

    const context: YamlPipelineContext = {
      provider,
      progress: nullReporter,
      cwd: '',
      inputs: flowInputsOf(job, {
        branch: scope.branch,
        baseBranch,
        // A stacked run's blocker branch, for its prompts (D10); its merge group stays the base's.
        stackBranch: job.run.stackedOn?.retargeted ? '' : (job.run.stackedOn?.branch ?? ''),
      }),
      outputs: {},
    };
    const result = await runPipeline(flow.value.pipeline, context, {
      signal: controller.signal,
      runId: job.run.id,
      gate,
      journal: databaseJournal(journalRows, journalCodec(context)),
      onStateChange: (change) => {
        // A node waiting for its group's slot (a merge behind another run's)
        // is the run's current step too, though it has not entered yet.
        if (change.kind !== 'entering' && change.kind !== 'waiting_slot') return;
        // Waiting for a stage's slot, the run is admitted and holds its place:
        // the tick that admitted it does not wait for the slot.
        if (change.kind === 'waiting_slot') agentStarted();
        trace.step = change.nodeName;
        void record({ currentStep: change.nodeName });
      },
    });
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
          priorities.delete(job.run.id);
          mergeOrder.delete(job.run.id);
          earlyOf.delete(job.run.id);
        });
      return started;
    },

    isActive: (runId: string) => active.has(runId),

    /**
     * Integrate a running flow's branch early (D8): the base moved and its pull
     * request no longer merges. `not-running`: no flow of this server drives it.
     */
    earlyIntegrate(runId: string): Promise<EarlyOutcome | 'not-running'> {
      const early = earlyOf.get(runId);
      return early ? early.request() : Promise.resolve('not-running');
    },

    /** Take the factory's stage limits as saved now (each tick): they apply to the next slot asked for. */
    noteFactory(factory: Pick<WatchedFactory, 'id' | 'stageLimits'>): void {
      stageLimits.set(factory.id, factory.stageLimits);
    },

    /** Stop driving one run's flow (the run was stopped); nothing more is written for it. */
    stop(runId: string): void {
      // It stays active until its flow returns, so a retry cannot start a
      // second flow for the run while this one is still unwinding.
      active.get(runId)?.abort();
    },

    /** Stop driving every flow (shutdown); their runs resume on the next start. */
    stopAll(): void {
      for (const controller of active.values()) controller.abort();
      active.clear();
      // Leases this server held expire unrenewed; another server takes over.
      stopGate();
    },
  };
}
