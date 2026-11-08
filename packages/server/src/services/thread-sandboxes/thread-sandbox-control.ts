/**
 * Stop, resume and destroy of a thread's sandbox (change thread-sandboxes).
 * Separate from provisioning so the idle stopper and wake-on-demand need only
 * a provider connection, the store and runner presence.
 *
 * Each operation is an Effect program: state moves are events of the shared
 * sandbox machine applied atomically by the store, and `onExit` handles typed
 * failures and interruptions alike (a wake cut by its timeout cannot leave the
 * row stuck in `connecting`). The public API stays `ResultAsync`.
 */

import type { SandboxEventType } from '@funny/shared/sandbox-machine';
import { Cause, Effect, Exit, Option } from 'effect';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import {
  isRetryableSandboxError,
  type SandboxError,
  type SandboxHandle,
  type SandboxProvider,
} from './contract.js';
import { fromResult, runToResult } from './effect-bridge.js';
import type { InfraConnectionService } from './infra-connections.js';
import { pollUntil } from './poll.js';
import { providerForConnection } from './sandbox-store-ops.js';
import type { ProvisionError } from './thread-sandbox-service.js';
import type {
  ThreadSandboxPatch,
  ThreadSandboxRow,
  ThreadSandboxState,
  ThreadSandboxStore,
} from './thread-sandbox-store.js';

export interface ThreadSandboxControlDeps {
  connections: Pick<InfraConnectionService, 'providerFor'>;
  sandboxRunnerIdForThread(threadId: string): Promise<string | null>;
  presence: { isAvailable(runnerId: string): boolean } | undefined;
  store: ThreadSandboxStore;
  sleep?: (ms: number) => PromiseLike<void>;
  pollMs?: number;
  connectTimeoutMs?: number;
  /** Provider-side safety cap; the idle stopper normally stops the sandbox first. */
  lifetimeMs?: number;
  /** Revokes the sandbox runner's registration (and with it its credentials). */
  removeRunner?: (runnerId: string) => Promise<void>;
  /** Retry of transient provider errors (defaults: DEFAULT_TRANSIENT_RETRY, `sleep`). */
  retry?: Partial<TransientRetryPolicy>;
}

/**
 * Provider-side lifetime of a sandbox per create/resume. Two hours fits the
 * strictest plan we know (Boat's trial refuses longer auto-stops); idle
 * sandboxes are stopped long before, and each resume grants a fresh window.
 */
export const DEFAULT_SANDBOX_LIFETIME_MS = 2 * 60 * 60_000;

/** Dead sandboxes: nothing will use their machine again. */
const RELEASABLE_STATES: ReadonlySet<ThreadSandboxState> = new Set(['failed', 'lost']);

export const sandboxError = (error: SandboxError): ProvisionError => ({
  kind: 'sandbox',
  message: error.message,
  cause: error.kind,
});

const storageError = (message: string): ProvisionError => ({ kind: 'storage', message });

/** The typed failure of an exit, or a description of its interruption / defect. */
export function exitFailure(exit: Exit.Exit<unknown, ProvisionError>): ProvisionError {
  if (Exit.isSuccess(exit)) return { kind: 'storage', message: 'not a failure' };
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) return failure.value;
  if (Cause.hasInterrupts(exit.cause)) {
    return { kind: 'cancelled', message: 'the operation was interrupted' };
  }
  return { kind: 'storage', message: String(Cause.squash(exit.cause)) };
}

/** Sandbox store and provider access shared by every lifecycle program. */
export function sandboxOps(
  deps: Pick<ThreadSandboxControlDeps, 'store' | 'connections' | 'sleep' | 'retry'>,
) {
  const retryPolicy: TransientRetryPolicy = {
    ...DEFAULT_TRANSIENT_RETRY,
    sleep: deps.sleep,
    ...deps.retry,
  };
  /** A repeatable provider call, retried on transient errors (see `idempotentProviderCall`). */
  const call = <A>(c: () => ResultAsync<A, SandboxError>) => idempotentProviderCall(c, retryPolicy);

  const get = (threadId: string) => fromResult(() => deps.store.get(threadId).mapErr(storageError));

  const update = (threadId: string, patch: ThreadSandboxPatch) =>
    fromResult(() => deps.store.update(threadId, patch).mapErr(storageError));

  /** Apply a machine event; refuse (fail) when the row's state does not accept it. */
  const transition = (threadId: string, event: SandboxEventType, patch?: ThreadSandboxPatch) =>
    Effect.flatMap(
      fromResult(() => deps.store.transition(threadId, event, patch).mapErr(storageError)),
      (outcome) =>
        outcome.applied
          ? Effect.succeed(outcome.state)
          : Effect.fail<ProvisionError>({
              kind: 'conflict',
              message: `sandbox is ${outcome.current ?? 'gone'}, cannot ${event}`,
            }),
    );

  /** Best-effort event on the way out of a failed operation: never fails. */
  const settle = (threadId: string, event: SandboxEventType, patch?: ThreadSandboxPatch) =>
    Effect.ignore(transition(threadId, event, patch));

  const providerFor = (row: ThreadSandboxRow) =>
    Effect.map(
      fromResult(() => providerForConnection(deps.connections, row.userId, row.connectionId)),
      ({ provider }) => provider,
    );

  /** The thread's sandbox in one of `states`, with its provider and machine handle. */
  const loadMachine = (threadId: string, states: readonly ThreadSandboxState[]) =>
    Effect.gen(function* () {
      const row = yield* get(threadId);
      if (!row || !row.sandboxId || !states.includes(row.state as ThreadSandboxState)) {
        return yield* Effect.fail<ProvisionError>({
          kind: 'sandbox',
          message: `thread has no ${states.join('/')} sandbox`,
          cause: 'not-found',
        });
      }
      const provider = yield* providerFor(row);
      const handle: SandboxHandle = { providerId: provider.id, sandboxId: row.sandboxId };
      return { row, provider, handle };
    });

  return { get, update, transition, settle, providerFor, loadMachine, call };
}

/** A provider call as an Effect failing with a `ProvisionError`. */
export const providerCall = <A>(call: () => ResultAsync<A, SandboxError>) =>
  fromResult(() => call().mapErr(sandboxError));

export interface TransientRetryPolicy {
  /** Retries after the first attempt. */
  retries: number;
  /** First backoff when the provider gives no `retryAfterMs`; doubles per retry. */
  baseDelayMs: number;
  /** Cap on any single wait, including a provider's `retryAfterMs`. */
  maxDelayMs: number;
  /** Injected wait for deterministic tests; defaults to Effect's interruptible sleep. */
  sleep?: (ms: number) => PromiseLike<void>;
}

const DEFAULT_TRANSIENT_RETRY: TransientRetryPolicy = {
  retries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/** The wait before retry `retry` (1-based) of a transient error. */
function transientRetryDelayMs(
  error: SandboxError,
  retry: number,
  policy: Pick<TransientRetryPolicy, 'baseDelayMs' | 'maxDelayMs'>,
): number {
  const hinted = 'retryAfterMs' in error ? error.retryAfterMs : undefined;
  const ms = hinted ?? policy.baseDelayMs * 2 ** (retry - 1);
  return Math.min(Math.max(0, ms), policy.maxDelayMs);
}

/**
 * A provider call that is safe to repeat (status, stop, resume, destroy, and
 * create thanks to its idempotency key), retried on transient errors
 * (rate-limited / unavailable) honoring the provider's `retryAfterMs`. Never
 * use it for `exec`: a command may have run before the error surfaced.
 */
function idempotentProviderCall<A>(
  call: () => ResultAsync<A, SandboxError>,
  policy: TransientRetryPolicy = DEFAULT_TRANSIENT_RETRY,
): Effect.Effect<A, ProvisionError> {
  const attempt = (retry: number): Effect.Effect<A, SandboxError> =>
    Effect.catch(
      fromResult(() => call()),
      (error) => {
        if (!isRetryableSandboxError(error) || retry > policy.retries) return Effect.fail(error);
        const ms = transientRetryDelayMs(error, retry, policy);
        const wait = policy.sleep;
        return Effect.flatMap(wait ? Effect.promise(() => wait(ms)) : Effect.sleep(ms), () =>
          attempt(retry + 1),
        );
      },
    );
  return Effect.mapError(attempt(1), sandboxError);
}

/** Wait until the thread's sandbox runner has enrolled and is connected; yields its id. */
export const waitForSandboxRunner = (
  deps: Pick<
    ThreadSandboxControlDeps,
    'sandboxRunnerIdForThread' | 'presence' | 'connectTimeoutMs' | 'pollMs' | 'sleep'
  >,
  threadId: string,
  what: string,
) =>
  fromResult((signal) =>
    pollUntil(
      () =>
        ResultAsync.fromSafePromise(deps.sandboxRunnerIdForThread(threadId)).map((runnerId) =>
          runnerId && deps.presence?.isAvailable(runnerId) ? runnerId : null,
        ),
      {
        what,
        timeoutMs: deps.connectTimeoutMs ?? 3 * 60_000,
        intervalMs: deps.pollMs ?? 2_000,
        signal,
        sleep: deps.sleep,
      },
    ).mapErr(sandboxError),
  );

export function createThreadSandboxControl(deps: ThreadSandboxControlDeps) {
  const ops = sandboxOps(deps);

  /**
   * Stop an idle sandbox. Disk-preserving providers stop it (resume brings it
   * back); ephemeral ones destroy it and the next wake re-provisions. A stop the
   * provider refuses leaves the machine — and the row — running.
   */
  const stop = (threadId: string) =>
    Effect.gen(function* () {
      const { provider, handle } = yield* ops.loadMachine(threadId, ['running']);
      const preserves = provider.capabilities().stopPreservesDisk;
      yield* ops.transition(threadId, 'STOP');
      yield* Effect.onExit(
        ops.call(() => (preserves ? provider.stop(handle) : provider.destroy(handle))),
        (exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : ops.settle(threadId, 'STOP_FAILED', { error: exitFailure(exit).message }),
      );
      return yield* ops.transition(threadId, preserves ? 'STOPPED' : 'LOST');
    });

  /**
   * Wake a stopped sandbox and wait until its runner reconnects (the runner
   * service restarts on boot with the credentials kept on disk). An expired or
   * vanished machine is `lost` (the thread must be re-provisioned); any other
   * failure — including the wake being cut short — is `failed`.
   */
  const resume = (threadId: string) =>
    Effect.gen(function* () {
      const { provider, handle } = yield* ops.loadMachine(threadId, ['stopped']);
      yield* ops.transition(threadId, 'RESUME');
      return yield* Effect.onExit(
        Effect.gen(function* () {
          yield* ops.call(() =>
            provider.resume(handle, { lifetimeMs: deps.lifetimeMs ?? DEFAULT_SANDBOX_LIFETIME_MS }),
          );
          const runnerId = yield* waitForSandboxRunner(
            deps,
            threadId,
            'sandbox runner reconnection',
          );
          yield* ops.transition(threadId, 'READY', { runnerId, error: null });
          return runnerId;
        }),
        (exit) => {
          if (Exit.isSuccess(exit)) return Effect.void;
          const error = exitFailure(exit);
          const lost =
            error.kind === 'sandbox' && (error.cause === 'expired' || error.cause === 'not-found');
          return ops.settle(threadId, lost ? 'LOST' : 'FAIL', { error: error.message });
        },
      );
    });

  /** Destroy a machine; one the provider no longer knows counts as destroyed. */
  const destroyMachine = (row: ThreadSandboxRow, sandboxId: string) =>
    Effect.gen(function* () {
      const provider = yield* ops.providerFor(row);
      yield* ops.call(() =>
        provider
          .destroy({ providerId: provider.id, sandboxId })
          .orElse((e) =>
            e.kind === 'not-found' || e.kind === 'expired'
              ? okAsync<void, SandboxError>(undefined)
              : errAsync<void, SandboxError>(e),
          ),
      );
    });

  /** Revoke the sandbox runner's registration (and with it its credentials). */
  const revokeRunner = (row: ThreadSandboxRow) =>
    Effect.gen(function* () {
      const runnerId =
        row.runnerId ?? (yield* Effect.promise(() => deps.sandboxRunnerIdForThread(row.threadId)));
      if (!runnerId || !deps.removeRunner) return;
      const revoke = deps.removeRunner;
      yield* Effect.tryPromise({
        try: () => revoke(runnerId),
        catch: (e): ProvisionError => ({ kind: 'storage', message: String(e) }),
      });
    });

  /**
   * Tear down the thread's sandbox for good (thread deleted): destroy the
   * machine, revoke its runner and drop the row. Any failure keeps the row
   * (state `failed`) so the reconciler retries it; the provider lifetime cap
   * bounds the leak meanwhile.
   */
  const destroy = (threadId: string) =>
    Effect.gen(function* () {
      const row = yield* ops.get(threadId);
      if (!row) return;
      yield* Effect.onExit(
        Effect.gen(function* () {
          if (row.sandboxId) yield* destroyMachine(row, row.sandboxId);
          yield* revokeRunner(row);
          yield* fromResult(() => deps.store.remove(threadId).mapErr(storageError));
        }),
        (exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.flatMap(
                ops.update(threadId, { error: `destroy failed: ${exitFailure(exit).message}` }),
                () => ops.settle(threadId, 'FAIL'),
              ).pipe(Effect.ignore),
      );
    });

  /**
   * Free the machine a dead sandbox (`failed` / `lost`) still holds: nothing
   * can use it again (a new sandbox is a new generation) but it keeps costing
   * until its lifetime cap. The row stays, so the thread still shows the
   * failure. A failure leaves `sandboxId` set for the next attempt.
   */
  const release = (threadId: string) =>
    Effect.gen(function* () {
      const row = yield* ops.get(threadId);
      if (!row?.sandboxId || !RELEASABLE_STATES.has(row.state as ThreadSandboxState)) return false;
      yield* destroyMachine(row, row.sandboxId);
      yield* revokeRunner(row);
      yield* ops.update(threadId, { sandboxId: null, runnerId: null });
      return true;
    });

  /**
   * Fail a sandbox whose operation is gone (the server restarted mid-setup,
   * mid-stop or mid-wake) and free its machine. The FAIL event is atomic: a
   * sandbox that has meanwhile reached a final state is left as it is.
   */
  const abandon = (threadId: string, reason: string) =>
    Effect.gen(function* () {
      yield* ops.settle(threadId, 'FAIL', { error: reason });
      return yield* release(threadId);
    });

  /**
   * Finish a stop or a wake whose operation died with the server, keeping the
   * disk: a wake whose runner is back is `running`; otherwise the machine is
   * put (back) to sleep, as the provider reports it. A provider failure leaves
   * the row for the next pass.
   */
  const recover = (threadId: string) =>
    Effect.gen(function* () {
      const { row, provider, handle } = yield* ops.loadMachine(threadId, [
        'connecting',
        'stopping',
      ]);
      if (row.state === 'connecting') {
        const runnerId = yield* Effect.promise(() => deps.sandboxRunnerIdForThread(threadId));
        if (runnerId && deps.presence?.isAvailable(runnerId)) {
          return yield* ops.transition(threadId, 'READY', { runnerId, error: null });
        }
        yield* ops.transition(threadId, 'STOP');
      }
      const status = yield* ops.call(() => provider.status(handle));
      if (status.state === 'lost') return yield* ops.transition(threadId, 'LOST');
      if (status.state === 'failed') {
        return yield* ops.transition(threadId, 'FAIL', {
          error: `sandbox ${status.detail ?? status.providerState}`,
        });
      }
      if (status.state === 'stopped') return yield* ops.transition(threadId, 'STOPPED');
      const preserves = provider.capabilities().stopPreservesDisk;
      yield* ops.call(() => (preserves ? provider.stop(handle) : provider.destroy(handle)));
      return yield* ops.transition(threadId, preserves ? 'STOPPED' : 'LOST');
    });

  const interrupted = (what: string) => (): ProvisionError => ({
    kind: 'sandbox',
    message: `sandbox ${what} was interrupted`,
    cause: 'unavailable',
  });

  return {
    stop(threadId: string): ResultAsync<ThreadSandboxState, ProvisionError> {
      return runToResult(stop(threadId), { onInterrupt: interrupted('stop') });
    },

    resume(threadId: string, signal?: AbortSignal): ResultAsync<string, ProvisionError> {
      return runToResult(resume(threadId), { signal, onInterrupt: interrupted('resume') });
    },

    destroy(threadId: string): ResultAsync<void, ProvisionError> {
      return runToResult(destroy(threadId), { onInterrupt: interrupted('destroy') });
    },

    /** Free the machine of a failed / lost sandbox. Yields whether there was one. */
    release(threadId: string): ResultAsync<boolean, ProvisionError> {
      return runToResult(release(threadId), { onInterrupt: interrupted('release') });
    },

    /** Settle an orphaned stop or wake, keeping the disk. Yields the state it ends in. */
    recover(threadId: string): ResultAsync<ThreadSandboxState, ProvisionError> {
      return runToResult(recover(threadId), { onInterrupt: interrupted('recovery') });
    },

    /** Fail an orphaned in-flight sandbox and free its machine. */
    abandon(threadId: string, reason: string): ResultAsync<boolean, ProvisionError> {
      return runToResult(abandon(threadId, reason), { onInterrupt: interrupted('cleanup') });
    },
  };
}

export type ThreadSandboxControl = ReturnType<typeof createThreadSandboxControl>;
