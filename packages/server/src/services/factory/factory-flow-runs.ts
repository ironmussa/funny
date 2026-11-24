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

import {
  nullReporter,
  runPipeline,
  type ConcurrencyGate,
  type MemoryGateOptions,
} from '@funny/pipelines';
import type { NodeOutput, YamlPipelineContext } from '@funny/workflows/compiler';

import { log } from '../../lib/logger.js';
import {
  createWorkflowJournalRepository,
  databaseJournal,
  type JournalCodec,
} from '../workflow-engine/journal-repository.js';
import { createLeaseGate } from '../workflow-engine/lease-gate.js';
import type { EarlyIntegration, EarlyOutcome } from './factory-early-integration.js';
import {
  flowOf,
  logFlowWarnings,
  traceRecorded,
  wasReopened,
  type FactoryFlowRunsDeps,
  type FactoryRunJob,
  type FlowTrace,
} from './factory-flow-runs-model.js';
import {
  blocksOthers,
  createRunProvider,
  scopeOf,
  type RunsInFlight,
} from './factory-flow-runs-provider.js';
import { createFlowSettlement } from './factory-flow-runs-settle.js';
import {
  formatFactoryFlowProblems,
  validateFlowForIssuelessRun,
} from './factory-flow-validation.js';
import {
  isMergeLane,
  flowReadsOf,
  loadFactoryFlow,
  type FactoryFlowContext,
  type FactoryFlow,
} from './factory-flow.js';
import { type FactoryRunView, type UpdateRunInput } from './factory-runs.js';
import { projectAgentDefaults, type WatchedFactory } from './factory-settings.js';
import { createThreadWaits } from './factory-thread-waits.js';

export type {
  FactoryFlowRunsDeps,
  FactoryRunJob,
  WaitingNotice,
} from './factory-flow-runs-model.js';

/** Whether a started run has an agent working (or is done), or never started one. */
export type FactoryRunStart = 'started' | 'not-started';

/**
 * The flow's inputs for a run: the issue's for an issue run, what its trigger
 * recorded otherwise, then the factory's own, which always win.
 */
export function flowInputsOf(
  job: Pick<FactoryRunJob, 'repo' | 'issue'> & {
    factory: Pick<WatchedFactory, 'id'>;
    run: Pick<FactoryRunView, 'inputs'>;
  },
  // What the host's concurrency groups are named by (the merge lane, stage limits),
  // and a stacked run's blocker branch (empty otherwise).
  at: { branch: string; baseBranch: string; stackBranch?: string },
): Record<string, string> {
  const subject = job.issue
    ? {
        issue_number: String(job.issue.number),
        issue_title: job.issue.title,
        issue_url: job.issue.url,
      }
    : job.run.inputs;
  return {
    ...subject,
    repo: job.repo,
    branch: at.branch,
    base_branch: at.baseBranch,
    factory_id: job.factory.id,
    stack_branch: at.stackBranch ?? '',
  };
}

/**
 * The journal keeps the flow's step outputs; the rest of the context (the
 * provider, the progress reporter, the inputs) is this attempt's, rebuilt by
 * the server that resumes the run.
 */
const journalCodec = (live: YamlPipelineContext): JournalCodec<YamlPipelineContext> => ({
  encode: (ctx) => ctx.outputs,
  decode: (stored) => ({ ...live, outputs: stored as Record<string, NodeOutput> }),
});

/** The given gate, or this server's lease gate with how to stop renewing its leases. */
function flowGate(
  given: ConcurrencyGate | undefined,
  rules: Pick<MemoryGateOptions, 'resolveLimit' | 'priority'>,
): { gate: ConcurrencyGate; stop: () => void } {
  if (given) return { gate: given, stop: () => {} };
  const leases = createLeaseGate(rules);
  return { gate: leases, stop: () => leases.stop() };
}

/** Admission times are ordered as whole seconds from here (they fit a 32-bit column). */
const PRIORITY_EPOCH_MS = Date.parse('2025-01-01T00:00:00.000Z');

/**
 * A run's place among the waiters of a group: the earlier it was admitted, the
 * sooner it gets the slot. A run blocked by another issue is admitted only
 * after its blocker finished, so admission order puts it behind.
 */
export function admissionPriority(run: Pick<FactoryRunView, 'admittedAt' | 'startedAt'>): number {
  const admitted = Date.parse(run.admittedAt ?? run.startedAt);
  if (!Number.isFinite(admitted)) return 0;
  return Math.max(0, Math.floor((admitted - PRIORITY_EPOCH_MS) / 1000));
}

/** A bucket's weight in a merge priority: above any admission order (seconds since 2026). */
const MERGE_BUCKET = 10_000_000_000;

/**
 * A run's place among the waiters of the merge group (openspec
 * factory-integration D11): a blocker of other runs first; then by size in
 * powers of four of its changed lines, so a much smaller change does not wait
 * behind a large one; within a size, admission order.
 */
export function mergePriority(
  admission: number,
  opts: { blocker: boolean; lines?: number },
): number {
  if (opts.blocker) return admission;
  const bucket = opts.lines && opts.lines > 1 ? Math.floor(Math.log(opts.lines) / Math.log(4)) : 0;
  return (1 + bucket) * MERGE_BUCKET + admission;
}

export function createFactoryFlowRuns(deps: FactoryFlowRunsDeps) {
  const active = new Map<string, AbortController>();
  /** Each running flow's early integration (D8), for the watcher to ask when the base moves. */
  const earlyOf = new Map<string, EarlyIntegration>();
  const waitThread = deps.waitThread ?? createThreadWaits();
  const journalRows = createWorkflowJournalRepository();
  /** Each run's place in a group's queue, by its id (the holder is `<runId>/<node>/<visit>`). */
  const priorities = new Map<string, number>();
  /** What orders a run in the merge group: whether it blocks other runs, and its size. */
  const mergeOrder = new Map<string, { blocker: boolean; lines?: number }>();
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

  const { flowUnavailable, cleanUpMerged, settle } = createFlowSettlement(deps);
  const inFlight: RunsInFlight = { earlyOf, mergeOrder };

  /**
   * Fail a run without an issue whose flow cannot run that way, before any
   * thread. The flow is read again for every run: it may have gained an
   * issue-only step or a required input since its trigger was saved.
   */
  async function refusedWithoutIssue(job: FactoryRunJob, flow: FactoryFlow): Promise<boolean> {
    if (job.issue !== null) return false;
    const problems = validateFlowForIssuelessRun(flow.workflow, Object.keys(job.run.inputs));
    if (problems.length === 0) return false;
    await deps.runs.updateInFlight(job.run.id, {
      state: 'failed',
      currentStep: null,
      failureReason: formatFactoryFlowProblems(`The flow "${flowOf(job)}"`, problems),
    });
    return true;
  }

  async function execute(
    job: FactoryRunJob,
    controller: AbortController,
    agentStarted: () => void,
  ): Promise<FactoryRunStart> {
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
      const live = await deps.runs.updateInFlight(job.run.id, input);
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
    const provider = createRunProvider(deps, inFlight, {
      job,
      scope,
      flow: flow.value,
      projectDefaults,
      controller,
      trace,
      record,
      gate,
      waitThread,
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
