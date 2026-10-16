/** Effect-backed orchestration at Promise and callback API boundaries. */
import { Cause, Clock, Duration, Effect, Exit, Schedule, Semaphore, Stream } from 'effect';

export interface AsyncOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutError?: () => unknown;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/** Preserve original errors (including domain error identity) across the runtime boundary. */
async function run<A>(effect: Effect.Effect<A, unknown>, options: AsyncOptions): Promise<A> {
  if (options.signal?.aborted) throw abortReason(options.signal);
  const timed =
    options.timeoutMs === undefined
      ? effect
      : Effect.timeoutOrElse(effect, {
          duration: options.timeoutMs,
          orElse: () => Effect.fail(options.timeoutError?.() ?? new Error('Operation timed out')),
        });
  const exit = await Effect.runPromiseExit(timed, { signal: options.signal });
  if (Exit.isSuccess(exit)) return exit.value;
  if (options.signal?.aborted) throw abortReason(options.signal);
  throw Cause.squash(exit.cause);
}

/** The operation must honor its signal to cancel external work, not just its wait. */
export function runAsync<A>(
  operation: (signal: AbortSignal) => PromiseLike<A>,
  options: AsyncOptions = {},
): Promise<A> {
  return run(Effect.tryPromise({ try: operation, catch: (error) => error }), options);
}

export interface RetryOptions extends AsyncOptions {
  /** Retries after the first attempt; omit to retry until success or a non-retryable error. */
  times?: number;
  /** Delay before retry `retry` (1-based) after `error`. */
  delayMs: (retry: number, error: unknown) => number;
  /** Errors for which this returns false are rethrown immediately. */
  while?: (error: unknown) => boolean;
  onRetry?: (error: unknown, retry: number, delayMs: number) => void;
  /** Injected wait for deterministic tests; defaults to Effect's interruptible clock. */
  sleep?: (ms: number) => PromiseLike<void>;
}

/** Retry policy as an Effect `Schedule`; `attempt` passed to the operation is 1-based. */
export function retryAsync<A>(
  operation: (signal: AbortSignal, attempt: number) => PromiseLike<A>,
  options: RetryOptions,
): Promise<A> {
  let attempt = 0;
  const once = Effect.tryPromise({
    try: (signal) => operation(signal, ++attempt),
    catch: (error) => error,
  });
  const { sleep: wait, onRetry } = options;
  const delayFor = (meta: Schedule.InputMetadata<unknown>) => {
    const ms = Math.max(0, options.delayMs(meta.attempt, meta.input));
    onRetry?.(meta.input, meta.attempt, ms);
    return ms;
  };
  const schedule = wait
    ? Schedule.tap(Schedule.spaced(0), (meta) => {
        const ms = delayFor(meta);
        return ms > 0 ? Effect.promise(() => wait(ms)) : Effect.void;
      })
    : Schedule.modifyDelay(Schedule.spaced(0), (meta) => Effect.succeed(delayFor(meta)));
  return run(Effect.retry(once, { schedule, times: options.times, while: options.while }), options);
}

/** Interruptible backoff/polling wait. UI animation timing should stay browser-native. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return run(Effect.sleep(ms), { signal });
}

/** Subscribe once; unsubscribe on success, failure, cancellation, or timeout. */
export function waitFor<A>(
  subscribe: (resolve: (value: A) => void, reject: (error: unknown) => void) => () => void,
  options: AsyncOptions = {},
): Promise<A> {
  let cleanup: (() => void) | undefined;
  const pending = Effect.callback<A, unknown>((resume) => {
    try {
      cleanup = subscribe(
        (value) => resume(Effect.succeed(value)),
        (error) => resume(Effect.fail(error)),
      );
    } catch (error) {
      resume(Effect.fail(error));
    }
  });
  return run(
    Effect.ensuring(
      pending,
      Effect.sync(() => cleanup?.()),
    ),
    options,
  );
}

/** Shared permits across calls; release on failure as well as success. */
export function createConcurrencyLimiter(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Concurrency must be a positive integer');
  }
  const semaphore = Semaphore.makeUnsafe(concurrency);
  return <A>(operation: () => PromiseLike<A>): Promise<A> =>
    run(
      semaphore.withPermits(1)(Effect.tryPromise({ try: operation, catch: (error) => error })),
      {},
    );
}

/** Acquire a permit with an optional deadline; caller releases the lease exactly once. */
export function createPermitPool(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Concurrency must be a positive integer');
  }
  const semaphore = Semaphore.makeUnsafe(concurrency);
  return {
    acquire(options: AsyncOptions = {}): Promise<() => void> {
      return run(
        Effect.map(semaphore.take(1), () => {
          let released = false;
          return () => {
            if (released) return;
            released = true;
            Effect.runSync(semaphore.release(1));
          };
        }),
        options,
      );
    },
  };
}

/** Consume agent events sequentially, with interruption and iterator finalization. */
export function consumeAsync<A>(
  source: AsyncIterable<A>,
  onItem: (item: A) => void | boolean | Promise<void | boolean>,
  options: AsyncOptions = {},
): Promise<void> {
  return run(
    Stream.runForEachWhile(
      Stream.fromAsyncIterable(source, (error) => error),
      (item) =>
        Effect.tryPromise({
          try: async () => (await onItem(item)) !== false,
          catch: (error) => error,
        }),
    ),
    options,
  );
}

/** An owned delayed task; cancellation is normal completion, other errors remain observable. */
export function scheduleTask(task: () => void | PromiseLike<void>, delayMs: number) {
  const controller = new AbortController();
  const program = Effect.gen(function* () {
    yield* Effect.sleep(delayMs);
    yield* Effect.tryPromise({ try: async () => task(), catch: (error) => error });
  });
  const done = run(program, { signal: controller.signal }).catch((error) => {
    if (!controller.signal.aborted) throw error;
  });
  return { cancel: () => controller.abort(), done };
}

/** Clock whose timers do not keep the process alive (`setTimeout(...).unref()`). */
function unrefSleep(duration: Duration.Duration): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    const handle = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
    (handle as { unref?: () => void }).unref?.();
    return Effect.sync(() => clearTimeout(handle));
  });
}

export interface RepeatOptions {
  /** Let the process exit while only this timer is pending. */
  unref?: boolean;
  /** Task failures are reported here and the schedule keeps running. */
  onError?: (error: unknown) => void;
}

/**
 * Periodic task that never overlaps itself: the next run is scheduled `intervalMs`
 * after the previous one finishes. Not for fixed-rate work such as heartbeats.
 */
export function scheduleRepeating(
  task: () => void | PromiseLike<void>,
  intervalMs: number,
  options: RepeatOptions = {},
) {
  const controller = new AbortController();
  const runOnce = Effect.catch(
    Effect.tryPromise({ try: async () => task(), catch: (error) => error }),
    (error) => Effect.sync(() => options.onError?.(error)),
  );
  const loop = Effect.andThen(
    Effect.sleep(intervalMs),
    Effect.repeat(runOnce, Schedule.spaced(intervalMs)),
  );
  const program = options.unref
    ? Effect.clockWith((clock) =>
        Effect.provideService(
          loop,
          Clock.Clock,
          Object.assign(Object.create(clock) as Clock.Clock, { sleep: unrefSleep }),
        ),
      )
    : loop;
  const done = run(Effect.asVoid(program), { signal: controller.signal }).catch((error) => {
    if (!controller.signal.aborted) throw error;
  });
  return { stop: () => controller.abort(), done };
}
