/**
 * Stale-while-revalidate cache, built on Effect's `Cache`, `FiberMap` and
 * `Semaphore`.
 *
 * A read never waits for a recomputation when a previous value exists: it gets
 * the last known value at once, and a stale one triggers a single background
 * refresh per key. Only a cold key (or one invalidated by a write) waits.
 *
 * - `Cache` shares one lookup between concurrent cold reads of a key, and keeps
 *   the previous value readable while a refresh runs.
 * - `FiberMap` (`onlyIfMissing`) keeps at most one background refresh per key.
 * - `Semaphore` bounds how many keys refresh at once.
 *
 * Lookups return a neverthrow `Result`; `get` returns one too, so service
 * boundaries keep their `Result` contracts. A failed refresh keeps serving the
 * previous value. Interrupting a refresh (on `invalidate`) stops waiting for
 * it, but cannot cancel work the lookup Promise already started.
 */
import { Cache, Cause, Duration, Effect, Exit, FiberMap, Option, Scope, Semaphore } from 'effect';
import { err, ok, type Result } from 'neverthrow';

export interface StaleWhileRevalidateOptions<A> {
  /** A value younger than this is served without a refresh. */
  freshMs: number;
  /** A value older than this is not served; the read waits for a new one. */
  maxStaleMs: number;
  /** Maximum number of keys kept. */
  capacity: number;
  /** Maximum number of background refreshes running at once. */
  refreshConcurrency: number;
  /** Equality used to decide whether a refresh changed the value. Defaults to JSON equality. */
  isEqual?: (a: A, b: A) => boolean;
  /** Reports a background refresh that failed; the previous value stays in place. */
  onRefreshError?: (key: string, error: unknown) => void;
  now?: () => number;
}

export interface ReadOptions<A, E> {
  /** Computes a fresh value for the key. The latest caller's lookup is used for refreshes. */
  lookup: () => Promise<Result<A, E>>;
  /** Called after a background refresh produced a value different from the one served. */
  onChanged?: (value: A) => void;
  /**
   * Opaque version of the source (e.g. a write counter). A value cached under a
   * different version is treated as invalidated: the read waits for a new one.
   */
  version?: number;
}

interface Entry<A> {
  value: A;
  at: number;
  version: number | undefined;
}

class LookupFailure<E> {
  constructor(readonly error: E) {}
}

const jsonEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createStaleWhileRevalidate<A, E = unknown>(
  options: StaleWhileRevalidateOptions<A>,
) {
  const now = options.now ?? (() => Date.now());
  const isEqual = options.isEqual ?? jsonEqual;
  const latest = new Map<string, ReadOptions<A, E>>();
  const scope = Scope.makeUnsafe();
  const permits = Semaphore.makeUnsafe(options.refreshConcurrency);
  const refreshes = Effect.runSync(Scope.provide(FiberMap.make<string>(), scope));

  const cache: Cache.Cache<string, Entry<A>, LookupFailure<E>> = Effect.runSync(
    Cache.makeWith(
      (key: string) =>
        Effect.gen(function* () {
          const read = latest.get(key);
          if (!read) return yield* Effect.die(new Error(`No lookup registered for ${key}`));
          const result = yield* Effect.promise(() => read.lookup());
          if (result.isOk()) return { value: result.value, at: now(), version: read.version };
          // A refresh that fails keeps the value it was refreshing: `Cache.refresh`
          // leaves the previous entry readable until the new lookup settles.
          const previous = yield* Cache.getSuccess(cache, key);
          if (Option.isSome(previous)) {
            options.onRefreshError?.(key, result.error);
            return previous.value;
          }
          return yield* Effect.fail(new LookupFailure(result.error));
        }),
      {
        capacity: options.capacity,
        // Failures are never cached; successes live until evicted or invalidated.
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      },
    ),
  );

  const refreshInBackground = (key: string, served: Entry<A>) =>
    FiberMap.run(
      refreshes,
      key,
      permits
        .withPermits(1)(
          Effect.gen(function* () {
            const next = yield* Cache.refresh(cache, key);
            if (next !== served && !isEqual(next.value, served.value)) {
              latest.get(key)?.onChanged?.(next.value);
            }
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (!Cause.hasInterruptsOnly(cause))
                options.onRefreshError?.(key, Cause.squash(cause));
            }),
          ),
        ),
      { onlyIfMissing: true },
    );

  const read = (key: string): Effect.Effect<A, LookupFailure<E>> =>
    Effect.gen(function* () {
      const version = latest.get(key)?.version;
      const cached = yield* Cache.getSuccess(cache, key);
      if (Option.isSome(cached)) {
        const entry = cached.value;
        const age = now() - entry.at;
        if (entry.version === version && age <= options.maxStaleMs) {
          if (age > options.freshMs) yield* refreshInBackground(key, entry);
          return entry.value;
        }
        // Too old, or computed before a write: never serve it.
        yield* invalidateEffect(key);
      }
      return (yield* Cache.get(cache, key)).value;
    });

  const invalidateEffect = (key: string) =>
    Effect.andThen(FiberMap.remove(refreshes, key), Cache.invalidate(cache, key));

  return {
    /** The cached value for `key`: fresh, stale (refreshing in the background), or newly computed. */
    async get(key: string, readOptions: ReadOptions<A, E>): Promise<Result<A, E>> {
      latest.set(key, readOptions);
      const exit = await Effect.runPromiseExit(read(key));
      if (Exit.isSuccess(exit)) return ok(exit.value);
      const failure = Cause.squash(exit.cause);
      if (failure instanceof LookupFailure) return err(failure.error as E);
      throw failure;
    },

    /** Drop the value (and any refresh in flight) for every key matching `predicate`. */
    invalidateWhere(predicate: (key: string) => boolean): void {
      const keys = Effect.runSync(Cache.keys(cache));
      for (const key of keys) {
        if (predicate(key)) Effect.runSync(invalidateEffect(key));
      }
      for (const key of latest.keys()) {
        if (predicate(key)) latest.delete(key);
      }
    },

    /** Drop every value and interrupt every refresh. */
    clear(): void {
      Effect.runSync(Effect.andThen(FiberMap.clear(refreshes), Cache.invalidateAll(cache)));
      latest.clear();
    },

    has(key: string): boolean {
      return Effect.runSync(Cache.has(cache, key));
    },
  };
}

export type StaleWhileRevalidate<A, E = unknown> = ReturnType<
  typeof createStaleWhileRevalidate<A, E>
>;
