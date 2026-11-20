/**
 * Running one node: its `when` guard, its execution with retry, and the
 * `entering` / `completed` / `skipped` / `error` state changes. The
 * scheduler decides what the outcome means for the run.
 */

import { Cause, Effect, Exit, Result } from 'effect';

import type { PipelineNode, PipelineStateChange } from './engine.js';

// Capture synchronous throws as well as rejected promises at the callback boundary.
export const invoke = <A>(fn: (signal: AbortSignal) => A | Promise<A>) =>
  Effect.tryPromise({
    try: async (abortSignal) => fn(abortSignal),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

/** How long an aborted node may take to stop before the run stops waiting for it. */
export const DEFAULT_STOP_GRACE_MS = 5_000;

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
  slot: Promise<() => void> | undefined,
  graceMs: number,
): Promise<void> {
  if (!slot) return;
  await settledWithin(
    slot.then(
      (release) => release(),
      () => undefined,
    ),
    graceMs,
  );
}

/** The message of whatever an Effect failed with. */
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
  params: {
    signal?: AbortSignal;
    emit: (c: PipelineStateChange<T>) => void;
    iteration: number;
    /** After an abort, how long to wait for the node's work to stop. */
    stopGraceMs?: number;
    /**
     * Ask for a concurrency slot once the guard passes. Resolves with its
     * release; `onWait` is called if the node has to wait for it.
     */
    acquireSlot?: (signal: AbortSignal, onWait: () => void) => Promise<() => void>;
  },
): Promise<SingleNodeResult<T>> {
  const { signal, emit, iteration } = params;
  let ctx = ctxIn;
  let committed = false;
  /** The node's last asynchronous execution, still running or not. */
  let inFlight: Promise<unknown> | undefined;
  /** The slot request, released once the node's work has stopped, whatever the outcome. */
  let slot: Promise<() => void> | undefined;
  const { acquireSlot } = params;
  if (signal?.aborted) return { ctx, status: 'cancelled' };

  const execution = Effect.gen(function* () {
    if (node.when && !(yield* invoke(() => node.when!(ctx)))) {
      return 'skipped' as const;
    }
    if (acquireSlot) {
      yield* invoke((abortSignal) => {
        slot = acquireSlot(abortSignal, () =>
          emit({ kind: 'waiting_slot', nodeName: node.name, ctx, iteration }),
        );
        return slot;
      });
    }
    emit({ kind: 'entering', nodeName: node.name, ctx, iteration });
    const retry = node.retry;
    const maxAttempts = retry
      ? Math.max(
          1,
          typeof retry.maxAttempts === 'function' ? retry.maxAttempts(ctx) : retry.maxAttempts,
        )
      : 1;

    for (let attempt = 1; ; attempt++) {
      const result = yield* Effect.result(
        invoke((abortSignal) => {
          const next = node.execute(ctx, abortSignal, { iteration });
          // A synchronous node can commit its result and request cancellation in
          // the same call. Preserve that completed work, but never adopt a late
          // Promise result after interruption.
          if (!next || typeof (next as Promise<T>).then !== 'function') {
            ctx = next as T;
            committed = true;
          } else {
            inFlight = Promise.resolve(next).catch(() => undefined);
          }
          return next;
        }),
      );
      if (Result.isSuccess(result)) {
        ctx = result.success;
        return 'completed' as const;
      }
      const error = result.failure;
      if (!retry || attempt >= maxAttempts) return yield* Effect.fail(error);
      if (retry.shouldRetry && !(yield* invoke(() => retry.shouldRetry!(error, ctx, attempt)))) {
        return yield* Effect.fail(error);
      }
      if (retry.beforeRetry) {
        ctx = yield* invoke(() => retry.beforeRetry!(error, ctx, attempt));
      }
      const delay = typeof retry.delayMs === 'function' ? retry.delayMs(ctx) : (retry.delayMs ?? 0);
      if (delay > 0) yield* Effect.sleep(delay);
    }
  });

  const exit = await Effect.runPromiseExit(execution, { signal });
  if (signal?.aborted) {
    // Interruption stops waiting, not the work: give the node's own abort
    // handling time to stop it, so the caller never sees it still running.
    if (inFlight) await settledWithin(inFlight, params.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    await releaseHeldSlot(slot, params.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    return { ctx, status: 'cancelled', committed };
  }
  await releaseHeldSlot(slot, params.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
  if (Exit.isFailure(exit)) {
    const error = causeMessage(exit.cause);
    emit({ kind: 'error', nodeName: node.name, ctx, iteration, error });
    return { ctx, status: 'error', error };
  }
  emit({ kind: exit.value, nodeName: node.name, ctx, iteration });
  return { ctx, status: exit.value };
}
