/**
 * Running one node: its `when` guard, its execution with retry, and the
 * `entering` / `completed` / `skipped` / `error` state changes. The
 * scheduler decides what the outcome means for the run.
 */

import { Cause, Effect, Exit, Result } from 'effect';

import type {
  NodeRunInfo,
  PipelineNode,
  PipelineStateChange,
  PipelineStateKind,
} from './engine.js';
import type { SlotGrant } from './gate.js';
import type { NodeData } from './types.js';

// Capture synchronous throws as well as rejected promises at the callback boundary.
export const invoke = <A>(fn: (signal: AbortSignal) => A | Promise<A>) =>
  Effect.tryPromise({
    try: async (abortSignal) => fn(abortSignal),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

/** How long an aborted node may take to stop before the run stops waiting for it. */
const DEFAULT_STOP_GRACE_MS = 5_000;

/** Wait for `work` to settle, or for `ms` to pass. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}

/**
 * Release a slot once its request settles. Reading the release from the
 * request itself (not from where the node saw it) also covers a grant that
 * landed just as the node was interrupted.
 */
async function releaseHeldSlot(
  slot: Promise<SlotGrant> | undefined,
  graceMs: number,
): Promise<void> {
  if (!slot) return;
  await settledWithin(
    slot.then(
      (grant) => {
        if (grant.kind === 'slot') grant.release();
      },
      () => undefined,
    ),
    graceMs,
  );
}

/** Any promise-like value, not only a native Promise. */
const isThenable = <T>(value: T | PromiseLike<T>): value is PromiseLike<T> =>
  // SAFETY: only reads `then` through optional chaining, so a nullish value or a value without
  // `then` yields undefined and fails the typeof check.
  typeof (value as { then?: unknown } | null)?.then === 'function';

/** The message of whatever an Effect failed with. */
/** Narrows a value-or-resolver option to its resolver member. */
function isResolver<V>(value: V): value is Extract<V, (...args: never[]) => void> {
  return typeof value === 'function';
}

export function causeMessage(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error ? squashed.message : String(squashed);
}

/** Outcome of running one node, before the caller decides pipeline flow. */
export interface SingleNodeResult<T> {
  /** Context after the node ran (unchanged if skipped). */
  ctx: T;
  status: 'completed' | 'skipped' | 'error' | 'cancelled';
  /** Set when status === 'error'. */
  error?: string;
  /** For 'cancelled': the node finished and its result is in `ctx`. */
  committed?: boolean;
}

/**
 * Run a single node: evaluate its `when` guard, execute with retry, and emit
 * `entering` / `completed` / `skipped` / `error` state changes. Does NOT emit
 * `terminal`: the scheduler decides what the outcome means for the run.
 *
 * Effect owns interruptible callback execution and retry waits.
 */
export async function runSingleNode<T>(
  node: PipelineNode<T>,
  ctxIn: T,
  params: SingleNodeParams<T>,
): Promise<SingleNodeResult<T>> {
  if (params.signal?.aborted) return { ctx: ctxIn, status: 'cancelled' };
  return new NodeExecution(node, ctxIn, params).run();
}

export interface SingleNodeParams<T> {
  signal?: AbortSignal;
  emit: (c: PipelineStateChange<T>) => void;
  iteration: number;
  /** After an abort, how long to wait for the node's work to stop. */
  stopGraceMs?: number;
  /**
   * Ask for a concurrency slot once the guard passes. Resolves with the
   * grant; `onWait` is called if the node has to wait for it.
   */
  acquireSlot?: (signal: AbortSignal, onWait: () => void) => Promise<SlotGrant>;
  /** A batch member's result context from the output its leader settled. */
  adoptBatchOutput?: (input: T, output: NodeData) => T;
  /** The rest of what the node is told about its execution. */
  info?: Omit<NodeRunInfo, 'iteration'>;
}

type Ending = 'skipped' | 'completed';

/** One execution of a node, with the state its steps share. */
class NodeExecution<T> {
  private ctx: T;
  /** A synchronous node returned its result: keep it even if the run was aborted. */
  private committed = false;
  /** The node's last asynchronous execution, still running or not. */
  private inFlight: Promise<unknown> | undefined;
  /** The slot request, released once the node's work has stopped, whatever the outcome. */
  private slot: Promise<SlotGrant> | undefined;
  private readonly runInfo: NodeRunInfo;

  constructor(
    private readonly node: PipelineNode<T>,
    ctxIn: T,
    private readonly params: SingleNodeParams<T>,
  ) {
    this.ctx = ctxIn;
    this.runInfo = {
      visit: String(params.iteration),
      checkpoint: async () => {},
      ...params.info,
      iteration: params.iteration,
    };
  }

  async run(): Promise<SingleNodeResult<T>> {
    const { signal } = this.params;
    const exit = await Effect.runPromiseExit(this.execution(), { signal });
    const grace = this.params.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    if (signal?.aborted) {
      // Interruption stops waiting, not the work: give the node's own abort
      // handling time to stop it, so the caller never sees it still running.
      if (this.inFlight) await settledWithin(this.inFlight, grace);
      await releaseHeldSlot(this.slot, grace);
      return { ctx: this.ctx, status: 'cancelled', committed: this.committed };
    }
    await releaseHeldSlot(this.slot, grace);
    if (Exit.isFailure(exit)) {
      const error = causeMessage(exit.cause);
      this.emit('error', error);
      return { ctx: this.ctx, status: 'error', error };
    }
    this.emit(exit.value);
    return { ctx: this.ctx, status: exit.value };
  }

  private emit(kind: PipelineStateKind, error?: string) {
    const { node, ctx, params } = this;
    params.emit({ kind, nodeName: node.name, ctx, iteration: params.iteration, error });
  }

  /** Guard, slot, then the node's attempts. */
  private execution(): Effect.Effect<Ending, Error> {
    return Effect.gen({ self: this }, function* () {
      const when = this.node.when;
      if (when && !(yield* invoke(() => when(this.ctx)))) return 'skipped' as const;
      const settled = yield* this.takeSlot();
      if (settled) return settled;
      this.emit('entering');
      return yield* this.attempts();
    });
  }

  /**
   * Wait for the node's slot, if it has a group. Ends the execution when a
   * batch leader already settled this node; otherwise lets it run.
   */
  private takeSlot(): Effect.Effect<Ending | undefined, Error> {
    const acquireSlot = this.params.acquireSlot;
    if (!acquireSlot) return Effect.succeed(undefined);
    return Effect.gen({ self: this }, function* () {
      const grant = yield* invoke((abortSignal) => {
        this.slot = acquireSlot(abortSignal, () => this.emit('waiting_slot'));
        return this.slot;
      });
      if (grant.kind === 'slot') {
        this.runInfo.batch = grant.batch;
        return undefined;
      }
      // A batch leader ran this node for us: take its outcome, without retries.
      const { outcome } = grant;
      if (outcome.status === 'failed') return yield* Effect.fail(new Error(outcome.error));
      const adopt = this.params.adoptBatchOutput;
      if (outcome.output !== undefined && adopt) this.ctx = adopt(this.ctx, outcome.output);
      return 'completed' as const;
    });
  }

  /** Execute the node, retrying as its `retry` config allows. */
  private attempts(): Effect.Effect<Ending, Error> {
    const retry = this.node.retry;
    const max = retry?.maxAttempts;
    const maxAttempts = Math.max(1, (isResolver(max) ? max(this.ctx) : max) ?? 1);
    return Effect.gen({ self: this }, function* () {
      for (let attempt = 1; ; attempt++) {
        const result = yield* Effect.result(this.attempt());
        if (Result.isSuccess(result)) {
          this.ctx = result.success;
          return 'completed' as const;
        }
        const error = result.failure;
        if (attempt >= maxAttempts || !(yield* this.prepareRetry(error, attempt))) {
          return yield* Effect.fail(error);
        }
      }
    });
  }

  /** One call of the node's `execute`. */
  private attempt(): Effect.Effect<T, Error> {
    return invoke((abortSignal) => {
      const next = this.node.execute(this.ctx, abortSignal, this.runInfo);
      // A synchronous node can commit its result and request cancellation in
      // the same call. Preserve that completed work, but never adopt a late
      // Promise result after interruption.
      if (isThenable(next)) {
        this.inFlight = Promise.resolve(next).catch(() => undefined);
      } else {
        this.ctx = next;
        this.committed = true;
      }
      return next;
    });
  }

  /** After a failed attempt: whether to retry, after the hook and the delay. */
  private prepareRetry(error: Error, attempt: number): Effect.Effect<boolean, Error> {
    const retry = this.node.retry;
    return Effect.gen({ self: this }, function* () {
      if (!retry) return false;
      const { shouldRetry, beforeRetry, delayMs } = retry;
      if (shouldRetry && !(yield* invoke(() => shouldRetry(error, this.ctx, attempt))))
        return false;
      if (beforeRetry) this.ctx = yield* invoke(() => beforeRetry(error, this.ctx, attempt));
      const delay = isResolver(delayMs) ? delayMs(this.ctx) : (delayMs ?? 0);
      if (delay > 0) yield* Effect.sleep(delay);
      return true;
    });
  }
}
