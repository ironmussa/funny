/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * The agent steps of the factory's `ActionProvider`: the thread each one
 * runs on (recorded, continued, adopted after an interruption, or new) and a
 * flow's `run_command` in the run's checkout.
 */

import type { ActionResult, RunCommandOpts, SpawnAgentOpts } from '@funny/workflows/compiler';

import { log } from '../../../lib/logger.js';
import { factoryRunLabel } from '../factory-runs.js';
import type { createStacking } from '../factory-stacking.js';
import { resolveStepOptions, type ResolvedStepOptions } from '../factory-step-options.js';
import { runStepOnRunner } from '../factory-step-runner.js';
import type { ThreadOutcome, WaitAfter } from '../factory-thread-waits.js';
import type { ActionCore } from './core.js';
import {
  CLOCK_SLACK_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  noCheckpoint,
  outcomeResult,
  prompted,
  refused,
  STEP_CHECKPOINT,
  stepAgentBody,
  type Checkpoint,
  type FactoryContinuation,
  type StepCheckpoint,
  type StepThread,
  type FactoryLaunchBody,
} from './shared.js';

/** Where a worktree run's branch starts, or why the step cannot start. */
export type WorktreeBase = { baseBranch?: string; baseFromRemote?: boolean } | { error: string };

/** What the agent steps read of the rest of the provider. */
interface StepThreadLinks {
  stacking: Pick<ReturnType<typeof createStacking>, 'base'>;
}

/** What the runner's agent says when it could not resume a thread's session (`orchestrator.ts`). */
const SESSION_LOST = /Session resume failed/i;

/** The agent steps of a run, and where a worktree run's branch starts. */
export function createStepThreads(core: ActionCore, links: StepThreadLinks) {
  const { deps, scope, threadIds, count } = core;
  const { stacking } = links;
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
      state: core.state.prUrl ? 'fixing' : 'working',
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
    const since = core.state.pendingLaunch;
    core.state.pendingLaunch = null;
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
    const since = core.state.pendingLaunch;
    core.state.pendingLaunch = null;
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
    if (core.state.prUrl)
      await count(
        { ...core.state.metrics, agentFixes: core.state.metrics.agentFixes + 1 },
        { event: 'agent_fix' },
      );
    const after = { completedAt: before, sentAt };
    await checkpoint({ phase: 'thread', threadId: first, after });
    return { threadId: await recordThread(first), after };
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

  /**
   * Where a worktree run's branch starts: the remote's default branch. Not
   * knowing it fails the step, since the runner would then start from whatever
   * the enabler's checkout has (run #227 opened a pull request with 11 commits
   * that were not the agent's).
   */
  async function worktreeBase(): Promise<
    { baseBranch?: string; baseFromRemote?: boolean } | { error: string }
  > {
    const base = stacking.base();
    if (scope.mode !== 'worktree' || !base) return {};
    const branch = await base;
    if (branch.isErr()) {
      return {
        error: `The agent could not start: the repository's default branch could not be read (${branch.error.message}).`,
      };
    }
    return { baseBranch: branch.value, baseFromRemote: true };
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
    const body: FactoryLaunchBody = {
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
    // Required: every later step is refused on another branch (`expectedBranch`),
    // so a thread put on one named from its title could never go on.
    if (!own) Object.assign(body, { branch: scope.branch, requireBranch: true });
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
    state: StepCheckpoint,
    checkpoint: Checkpoint,
    options: ResolvedStepOptions,
  ): Promise<StepThread | undefined> {
    if (state.phase === 'thread') {
      return { threadId: await rememberThread(state.threadId), after: state.after };
    }
    if (state.phase === 'launching') {
      const found = await deps.findLaunched(titlePrefixOf(options), state.since);
      if (!found) return undefined;
      await checkpoint({ phase: 'thread', threadId: found });
      return { threadId: await rememberThread(found) };
    }
    const continuation = deps.continuation;
    if (!continuation || !(await continuation.followedUpSince(state.threadId, state.since))) {
      return undefined;
    }
    // Sent before the interruption: wait for that run, do not send it twice.
    const after = { completedAt: state.before, sentAt: state.since };
    await checkpoint({ phase: 'thread', threadId: state.threadId, after });
    return { threadId: await rememberThread(state.threadId), after };
  }

  /** A journaled step's thread: adopted from its checkpoint, a follow-up, or new. */
  async function journaledThreadFor(
    opts: SpawnAgentOpts,
    options: ResolvedStepOptions,
  ): Promise<StepThread | ActionResult> {
    const execution = opts.execution;
    const checkpoint: Checkpoint = execution
      ? (state) => execution.checkpoint(state)
      : noCheckpoint;
    // The journal resumes the run; the launch marker belongs to the numbering path.
    core.state.pendingLaunch = null;
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

  /** The options this agent step runs with, the factory's overrides read now. */
  async function optionsOf(opts: SpawnAgentOpts, index: number): Promise<ResolvedStepOptions> {
    return resolveStepOptions({
      stepId: opts.stepId ?? `step-${index}`,
      step: opts,
      flowDefaults: opts.defaults,
      overrides: (await deps.stepOverrides?.()) ?? {},
      project: deps.projectDefaults,
    });
  }

  /** An agent step: a thread on the enabler's runner (the first, or a follow-up on it). */
  async function agentStep(opts: SpawnAgentOpts): Promise<ActionResult> {
    const index = core.state.agentSteps++;
    const options = await optionsOf(opts, index);
    const step =
      (deps.legacyReplay ?? true)
        ? await threadFor(opts, options, index)
        : await journaledThreadFor(opts, options);
    if (!('threadId' in step)) return step;
    if (!step.replayed) await deps.recordStepOptions?.({ ...options, threadId: step.threadId });
    // A replayed step that a LATER recorded step continued on the same thread
    // finished before that one started: waiting on the thread now would read
    // the later step's run instead of this one.
    if (step.replayed && threadIds.slice(index + 1).includes(step.threadId)) {
      return { ok: true, output: '', metadata: { threadId: step.threadId, replayed: true } };
    }
    const outcome = await deps.waitThread(step.threadId, deps.signal, step.after);
    const resent = await resendAfterLostSession(step, outcome, opts, options);
    return outcomeResult(step.threadId, resent ?? outcome);
  }

  /**
   * A follow-up whose agent could not resume its session fails at once (0
   * turns) and asks for the message again: the runner clears the session, and
   * the next message starts a new one with the thread's history in its prompt.
   * Send it once more and wait for that turn, as a person would (#455, #481:
   * a day-old session, and both runs parked for a person). Null when the
   * failure was anything else, or the step was not a follow-up.
   */
  async function resendAfterLostSession(
    step: StepThread,
    outcome: ThreadOutcome,
    opts: SpawnAgentOpts,
    options: ResolvedStepOptions,
  ): Promise<ThreadOutcome | null> {
    const continuation = deps.continuation;
    if (outcome.status !== 'failed' || !step.after || !continuation || !deps.lastAgentError) {
      return null;
    }
    const error = await deps.lastAgentError(step.threadId, step.after.sentAt);
    if (!error || !SESSION_LOST.test(error)) return null;
    const before = await continuation.completedAt(step.threadId);
    const sentAt = new Date().toISOString();
    const sent = await continuation.followUp(step.threadId, prompted(opts), stepAgentBody(options));
    if (sent.isErr()) return null;
    log.info('Issue factory sent a follow-up again after its agent lost its session', {
      namespace: 'factory',
      runId: scope.runId,
      threadId: step.threadId,
    });
    return deps.waitThread(step.threadId, deps.signal, { completedAt: before, sentAt });
  }
  return { agentStep, worktreeBase };
}

/**
 * A flow's `run_command`, run by the runner in the run's own checkout (the
 * implementing thread's), never on the server. The exit code decides: a
 * non-zero exit, a timeout or a stop fails the step with the end of its output.
 */
export async function runCommandStep(
  core: ActionCore,
  opts: RunCommandOpts,
): Promise<ActionResult> {
  const { deps, threadIds } = core;
  if (!deps.steps) {
    return refused('run_command', 'this server cannot run factory steps on a runner.');
  }
  const threadId = threadIds[0];
  if (!threadId) {
    return {
      ok: false,
      error: 'run_command needs the run checkout: an agent step has to start it first.',
    };
  }
  const timeoutMs = opts.timeout ?? DEFAULT_STEP_TIMEOUT_MS;
  const run = await runStepOnRunner(
    deps.steps,
    threadId,
    { kind: 'command', command: opts.command, timeoutMs },
    deps.signal,
  );
  if (run.kind === 'unavailable') {
    return { ok: false, error: `run_command could not run: ${run.why}` };
  }
  if (run.result.kind !== 'command') return { ok: false, error: 'run_command: unexpected result.' };
  const { outcome, exitCode, stdout, stderr, durationMs } = run.result;
  const metadata = { outcome, exitCode, stdout, stderr, durationMs };
  if (outcome === 'passed') return { ok: true, output: stdout, metadata };
  const tail = (stderr.trim() || stdout.trim()).slice(-4000);
  const how = outcome === 'failed' ? `exited ${exitCode}` : outcome;
  return { ok: false, error: `The command ${how}:\n${tail}`, metadata };
}
