/**
 * Boundary between the sandbox lifecycle's Effect programs and the
 * `neverthrow` contracts the rest of funny uses (change thread-sandboxes).
 *
 * Inside, sandbox operations are Effect programs: lazy steps, scoped
 * resources released on failure *and* interruption, declared timeouts. At the
 * edges, providers and stores speak `ResultAsync`, and the public service API
 * stays `ResultAsync` (see CLAUDE.md "Error Handling with neverthrow").
 */

import { Cause, Effect, Exit, Option } from 'effect';
import { err, ok, ResultAsync, type Result } from 'neverthrow';

/**
 * A lazily-started `ResultAsync` as an Effect failing with its typed error. The
 * signal aborts when the program is interrupted, so cancellable operations
 * (polls, waits) stop with it.
 */
export function fromResult<A, E>(
  thunk: (signal: AbortSignal) => PromiseLike<Result<A, E>>,
): Effect.Effect<A, E> {
  return Effect.flatMap(
    Effect.promise((signal) => thunk(signal)),
    (result) => (result.isOk() ? Effect.succeed(result.value) : Effect.fail(result.error)),
  );
}

/**
 * Run a program as a `ResultAsync`. `signal` interrupts it — finalizers
 * (e.g. destroying a machine) still run — and the interruption surfaces as
 * `onInterrupt()`. A defect (a thrown bug) is rethrown, never swallowed.
 */
export function runToResult<A, E>(
  program: Effect.Effect<A, E>,
  options: { signal?: AbortSignal; onInterrupt: () => E },
): ResultAsync<A, E> {
  return new ResultAsync(
    (async (): Promise<Result<A, E>> => {
      const exit = await Effect.runPromiseExit(program, { signal: options.signal });
      if (Exit.isSuccess(exit)) return ok(exit.value);
      const failure = Cause.findErrorOption(exit.cause);
      if (Option.isSome(failure)) return err(failure.value);
      if (Cause.hasInterrupts(exit.cause)) return err(options.onInterrupt());
      throw Cause.squash(exit.cause);
    })(),
  );
}
