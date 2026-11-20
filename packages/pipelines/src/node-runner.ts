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
  params: { signal?: AbortSignal; emit: (c: PipelineStateChange<T>) => void; iteration: number },
): Promise<SingleNodeResult<T>> {
  const { signal, emit, iteration } = params;
  let ctx = ctxIn;
  let committed = false;
  if (signal?.aborted) return { ctx, status: 'cancelled' };

  const execution = Effect.gen(function* () {
    if (node.when && !(yield* invoke(() => node.when!(ctx)))) {
      return 'skipped' as const;
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
          const next = node.execute(ctx, abortSignal);
          // A synchronous node can commit its result and request cancellation in
          // the same call. Preserve that completed work, but never adopt a late
          // Promise result after interruption.
          if (!next || typeof (next as Promise<T>).then !== 'function') {
            ctx = next as T;
            committed = true;
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
  if (signal?.aborted) return { ctx, status: 'cancelled', committed };
  if (Exit.isFailure(exit)) {
    const error = causeMessage(exit.cause);
    emit({ kind: 'error', nodeName: node.name, ctx, iteration, error });
    return { ctx, status: 'error', error };
  }
  emit({ kind: exit.value, nodeName: node.name, ctx, iteration });
  return { ctx, status: exit.value };
}
