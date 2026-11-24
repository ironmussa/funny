/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * The agent steps of the factory's `ActionProvider` (`factory-action-provider.ts`):
 * which thread a `spawn_agent` step runs on (recorded, continued, adopted
 * after an interruption, or new) and the step's result from its terminal status.
 */

import type { ActionResult, SpawnAgentOpts } from '@funny/workflows/compiler';
import { z } from 'zod';

import type {
  FactoryContinuation,
  ProviderContext,
  StepAgentBody,
} from './factory-action-provider-deps.js';
import { factoryRunLabel } from './factory-runs.js';
import { resolveStepOptions, type ResolvedStepOptions } from './factory-step-options.js';
import type { ThreadOutcome, WaitAfter } from './factory-thread-waits.js';

/** The body fields of a step's resolved options: every kept field explicit, the rest only when set. */
function stepAgentBody(options: ResolvedStepOptions): StepAgentBody {
  const body: StepAgentBody = {
    provider: options.provider,
    model: options.model,
    permissionMode: options.permissionMode,
  };
  if (options.effort) body.effort = options.effort;
  if (options.allowedTools) body.allowedTools = options.allowedTools;
  if (options.disallowedTools) body.disallowedTools = options.disallowedTools;
  return body;
}

/** The thread an agent step waits on; `after` when a follow-up runs it again. */
interface StepThread {
  threadId: string;
  after?: WaitAfter;
  /** A step recorded before a resume, retry or take-over. */
  replayed?: boolean;
}

/**
 * What an agent step records in the journal about its work in progress, so
 * a resumed execution adopts it instead of starting it again.
 */
const STEP_CHECKPOINT = z.discriminatedUnion('phase', [
  /** A launch was being made since `since`; its thread may exist. */
  z.object({ phase: z.literal('launching'), since: z.string() }),
  /** A follow-up was being sent to `threadId` since `since`. */
  z.object({
    phase: z.literal('following-up'),
    threadId: z.string(),
    since: z.string(),
    before: z.string().nullable(),
  }),
  /** The step's thread, and what its wait waits for when a follow-up runs it again. */
  z.object({
    phase: z.literal('thread'),
    threadId: z.string(),
    after: z.object({ completedAt: z.string().nullable(), sentAt: z.string() }).optional(),
  }),
]);
type StepCheckpoint = z.infer<typeof STEP_CHECKPOINT>;

/** Record a checkpoint of the step in progress (a no-op outside a journaled run). */
type Checkpoint = (state: StepCheckpoint) => Promise<void>;

const noCheckpoint: Checkpoint = async () => {};

/** Allowance for the runner's clock when comparing its timestamps with the server's. */
const CLOCK_SLACK_MS = 60 * 1000;

/** Where a worktree run's branch starts, or why it cannot start. */
type WorktreeBase = () => Promise<
  { baseBranch?: string; baseFromRemote?: boolean } | { error: string }
>;

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

/** The options this agent step runs with, the factory's overrides read now. */
async function optionsOf(
  ctx: ProviderContext,
  opts: SpawnAgentOpts,
  index: number,
): Promise<ResolvedStepOptions> {
  return resolveStepOptions({
    stepId: opts.stepId ?? `step-${index}`,
    step: opts,
    flowDefaults: opts.defaults,
    overrides: (await ctx.deps.stepOverrides?.()) ?? {},
    project: ctx.deps.projectDefaults,
  });
}

/** How an agent step finds its thread. */
function createStepThreads(ctx: ProviderContext, worktreeBase: WorktreeBase) {
  const { deps, scope, state } = ctx;
  const { threadIds } = state;
  // How the run is named in its thread titles: `#<issue>`, or `run-<id>` without one.
  const label = factoryRunLabel({ id: scope.runId, issueNumber: scope.issueNumber });
  const titlePrefix = `[Factory] ${label} `;
  /**
   * The title prefix of a step's thread: the implementing thread's, or one of
   * its own for a `thread: new` step, so adopting an interrupted launch never
   * mistakes one for the other.
   */
  const titlePrefixOf = (options: ResolvedStepOptions) =>
    options.thread === 'new' ? `[Factory ${options.stepId}] ${label} ` : titlePrefix;
  const titleOf = (options: ResolvedStepOptions) =>
    `${titlePrefixOf(options)}${scope.issueTitle}`.slice(0, 200);

  /** Record the step's thread; the launch marker is cleared in the same write. */
  async function recordThread(threadId: string): Promise<string> {
    threadIds.push(threadId);
    // A fix after the pull request is open is a `fixing` step, not new work.
    await deps.record({
      state: state.prUrl ? 'fixing' : 'working',
      threadIds: [...threadIds],
      launchStartedAt: null,
    });
    // Stopped while the launch was in flight: the stop missed this thread.
    if (deps.signal.aborted) await deps.abandon?.(threadId);
    return threadId;
  }

  /** The thread an interrupted launch of this step started, if it got that far. */
  async function adoptInterrupted(
    step: number,
    options: ResolvedStepOptions,
  ): Promise<string | null> {
    const since = state.pendingLaunch;
    state.pendingLaunch = null;
    if (!since || step !== threadIds.length) return null;
    const found = await deps.findLaunched(titlePrefixOf(options), since);
    return found && !threadIds.includes(found) ? found : null;
  }

  /** Continue the run's first thread with this step's prompt (a later agent step). */
  async function followUp(
    continuation: FactoryContinuation,
    first: string,
    opts: SpawnAgentOpts,
    options: ResolvedStepOptions,
    checkpoint: Checkpoint = noCheckpoint,
  ): Promise<StepThread | ActionResult> {
    const since = state.pendingLaunch;
    state.pendingLaunch = null;
    if (since && (await continuation.followedUpSince(first, since))) {
      // Sent before an interruption: wait for that run, do not send it twice.
      return {
        threadId: await recordThread(first),
        after: await interruptedAfter(continuation, first, since),
      };
    }
    const before = await continuation.completedAt(first);
    const sentAt = new Date().toISOString();
    await checkpoint({ phase: 'following-up', threadId: first, since: sentAt, before });
    await deps.record({ launchStartedAt: sentAt });
    const sent = await continuation.followUp(first, prompted(opts), stepAgentBody(options));
    if (sent.isErr()) {
      await deps.record({ launchStartedAt: null });
      return { ok: false, error: `The agent could not continue: ${sent.error}` };
    }
    // A follow-up once the pull request is open is a fix (CI or conflict), not new work.
    if (state.prUrl) {
      await ctx.count(
        { ...state.metrics, agentFixes: state.metrics.agentFixes + 1 },
        { event: 'agent_fix' },
      );
    }
    const after = { completedAt: before, sentAt };
    await checkpoint({ phase: 'thread', threadId: first, after });
    return { threadId: await recordThread(first), after };
  }

  /** Start a new thread for this step, marked first so a crash in between is adopted. */
  async function launchNew(
    opts: SpawnAgentOpts,
    options: ResolvedStepOptions,
    checkpoint: Checkpoint = noCheckpoint,
  ): Promise<StepThread | ActionResult> {
    const base = await worktreeBase();
    if ('error' in base) return { ok: false, error: base.error };
    const since = new Date().toISOString();
    await checkpoint({ phase: 'launching', since });
    await deps.record({ launchStartedAt: since });
    const own = options.thread === 'new';
    const body: Record<string, unknown> = {
      projectId: scope.projectId,
      title: titleOf(options),
      mode: scope.mode,
      ...base,
      source: 'factory',
      prompt: prompted(opts),
      ...stepAgentBody(options),
    };
    // A worktree thread is created on the run's branch, so the thread, its
    // worktree and the pull request share one branch. A step on its own
    // thread is read-only and reads the branch from the remote instead.
    if (!own) body.branch = scope.branch;
    // A step on its own thread may only read: the runner holds it to that
    // (its OS sandbox), whatever the agent tries; `plan` alone is a prompt.
    if (own) body.readOnly = true;
    const launched = await deps.launch(body);
    const threadId = launched.isOk() ? launched.value.threadId : undefined;
    if (threadId) {
      await checkpoint({ phase: 'thread', threadId });
      return { threadId: await recordThread(threadId) };
    }
    await deps.record({ launchStartedAt: null });
    return {
      ok: false,
      error: launched.isErr()
        ? `The agent could not start: ${launched.error.message}`
        : 'The agent could not start: the runner returned no thread.',
    };
  }

  /** Record `threadId` in the display list unless a resumed step already did. */
  const rememberThread = async (threadId: string) =>
    threadIds.includes(threadId) ? threadId : recordThread(threadId);

  /**
   * The work a resumed journaled step checkpointed, adopted: its thread, or
   * the thread its interrupted launch started, or its follow-up when it was
   * sent. Undefined when there is nothing to adopt and the step starts over.
   */
  async function adoptCheckpoint(
    saved: StepCheckpoint,
    checkpoint: Checkpoint,
    options: ResolvedStepOptions,
  ): Promise<StepThread | undefined> {
    if (saved.phase === 'thread') {
      return { threadId: await rememberThread(saved.threadId), after: saved.after };
    }
    if (saved.phase === 'launching') {
      const found = await deps.findLaunched(titlePrefixOf(options), saved.since);
      if (!found) return undefined;
      await checkpoint({ phase: 'thread', threadId: found });
      return { threadId: await rememberThread(found) };
    }
    const continuation = deps.continuation;
    if (!continuation || !(await continuation.followedUpSince(saved.threadId, saved.since))) {
      return undefined;
    }
    // Sent before the interruption: wait for that run, do not send it twice.
    const after = { completedAt: saved.before, sentAt: saved.since };
    await checkpoint({ phase: 'thread', threadId: saved.threadId, after });
    return { threadId: await rememberThread(saved.threadId), after };
  }

  /** A journaled step's thread: adopted from its checkpoint, a follow-up, or new. */
  async function journaledThreadFor(
    opts: SpawnAgentOpts,
    options: ResolvedStepOptions,
  ): Promise<StepThread | ActionResult> {
    const execution = opts.execution;
    const checkpoint: Checkpoint = execution
      ? (saved) => execution.checkpoint(saved)
      : noCheckpoint;
    // The journal resumes the run; the launch marker belongs to the numbering path.
    state.pendingLaunch = null;
    const saved = STEP_CHECKPOINT.safeParse(execution?.resume?.recorded.data);
    const adopted = saved.success
      ? await adoptCheckpoint(saved.data, checkpoint, options)
      : undefined;
    if (adopted) return adopted;
    const first = threadIds[0];
    if (first && deps.continuation && options.thread !== 'new') {
      return followUp(deps.continuation, first, opts, options, checkpoint);
    }
    return launchNew(opts, options, checkpoint);
  }

  /** The thread of the current agent step: recorded, continued, adopted, or new. */
  async function threadFor(
    opts: SpawnAgentOpts,
    options: ResolvedStepOptions,
    step: number,
  ): Promise<StepThread | ActionResult> {
    const recorded = threadIds[step];
    if (recorded) return { threadId: recorded, replayed: true };
    const first = threadIds[0];
    if (step > 0 && first && deps.continuation && options.thread !== 'new') {
      return followUp(deps.continuation, first, opts, options);
    }
    const adopted = await adoptInterrupted(step, options);
    return adopted ? { threadId: await recordThread(adopted) } : launchNew(opts, options);
  }

  return { journaledThreadFor, threadFor };
}

/** The `spawn_agent` step: a thread on the enabler's runner (the first, or a follow-up on it). */
export function createAgentStep(ctx: ProviderContext, worktreeBase: WorktreeBase) {
  const { deps, state } = ctx;
  const threads = createStepThreads(ctx, worktreeBase);

  return async function agentStep(opts: SpawnAgentOpts): Promise<ActionResult> {
    const index = state.agentSteps++;
    const options = await optionsOf(ctx, opts, index);
    const step =
      (deps.legacyReplay ?? true)
        ? await threads.threadFor(opts, options, index)
        : await threads.journaledThreadFor(opts, options);
    if (!('threadId' in step)) return step;
    if (!step.replayed) await deps.recordStepOptions?.({ ...options, threadId: step.threadId });
    // A replayed step that a LATER recorded step continued on the same thread
    // finished before that one started: waiting on the thread now would read
    // the later step's run instead of this one.
    if (step.replayed && state.threadIds.slice(index + 1).includes(step.threadId)) {
      return { ok: true, output: '', metadata: { threadId: step.threadId, replayed: true } };
    }
    return outcomeResult(
      step.threadId,
      await deps.waitThread(step.threadId, deps.signal, step.after),
    );
  };
}

/** An early integration's conflict, as a follow-up on the implementing thread, waited for. */
export async function conflictToImplementer(ctx: ProviderContext, feedback: string): Promise<void> {
  const { deps, state } = ctx;
  const threadId = state.threadIds[0];
  const continuation = deps.continuation;
  if (!threadId || !continuation) return;
  const completedAt = await continuation.completedAt(threadId);
  const sentAt = new Date().toISOString();
  const sent = await continuation.followUp(threadId, feedback);
  if (sent.isErr()) return;
  await ctx.count(
    { ...state.metrics, agentFixes: state.metrics.agentFixes + 1 },
    { event: 'agent_fix_early' },
  );
  await deps.waitThread(threadId, deps.signal, { completedAt, sentAt });
}
