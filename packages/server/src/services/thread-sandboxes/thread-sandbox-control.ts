/**
 * Stop and resume of a thread's sandbox (change thread-sandboxes). Separate from
 * provisioning so the idle stopper and wake-on-demand need only a provider
 * connection, the store and runner presence.
 */

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import type { SandboxError, SandboxHandle, SandboxProvider } from './contract.js';
import type { InfraConnectionService } from './infra-connections.js';
import { pollUntil } from './poll.js';
import { providerForConnection, sandboxStoreOps } from './sandbox-store-ops.js';
import type { ProvisionError } from './thread-sandbox-service.js';
import type {
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
}

/**
 * Provider-side lifetime of a sandbox per create/resume. Two hours fits the
 * strictest plan we know (Boat's trial refuses longer auto-stops); idle
 * sandboxes are stopped long before, and each resume grants a fresh window.
 */
export const DEFAULT_SANDBOX_LIFETIME_MS = 2 * 60 * 60_000;

export const sandboxError = (error: SandboxError): ProvisionError => ({
  kind: 'sandbox',
  message: error.message,
  cause: error.kind,
});

export function createThreadSandboxControl(deps: ThreadSandboxControlDeps) {
  const { pollMs, fromStore, setState } = sandboxStoreOps(deps);

  /** Load the thread's sandbox in one of `states` and its provider client. */
  function withProvider<T>(
    threadId: string,
    states: ThreadSandboxState[],
    run: (
      row: ThreadSandboxRow,
      provider: SandboxProvider,
      handle: SandboxHandle,
    ) => ResultAsync<T, ProvisionError>,
  ): ResultAsync<T, ProvisionError> {
    return fromStore(deps.store.get(threadId)).andThen((row) => {
      if (!row || !row.sandboxId || !states.includes(row.state as ThreadSandboxState)) {
        return errAsync<T, ProvisionError>({
          kind: 'sandbox',
          message: `thread has no ${states.join('/')} sandbox`,
          cause: 'not-found',
        });
      }
      const sandboxId = row.sandboxId;
      return providerForConnection(deps.connections, row.userId, row.connectionId).andThen(
        ({ provider }) => run(row, provider, { providerId: provider.id, sandboxId }),
      );
    });
  }

  return {
    /**
     * Stop an idle sandbox. Disk-preserving providers stop it (resume brings it
     * back); ephemeral ones destroy it and the next wake re-provisions.
     */
    stop(threadId: string): ResultAsync<ThreadSandboxState, ProvisionError> {
      return withProvider(threadId, ['running'], (row, provider, handle) => {
        const preserves = provider.capabilities().stopPreservesDisk;
        const action = preserves ? provider.stop(handle) : provider.destroy(handle);
        const next: ThreadSandboxState = preserves ? 'stopped' : 'lost';
        return setState(row.threadId, 'stopping')
          .andThen(() => action.mapErr(sandboxError))
          .andThen(() => setState(row.threadId, next))
          .map(() => next);
      });
    },

    /**
     * Wake a stopped sandbox and wait until its runner reconnects (the runner
     * service restarts on boot with the credentials kept on disk).
     */
    resume(threadId: string, signal?: AbortSignal): ResultAsync<string, ProvisionError> {
      return withProvider(threadId, ['stopped'], (row, provider, handle) =>
        setState(row.threadId, 'connecting')
          .andThen(() =>
            provider
              .resume(handle, { lifetimeMs: deps.lifetimeMs ?? DEFAULT_SANDBOX_LIFETIME_MS })
              .mapErr(sandboxError),
          )
          .andThen(() =>
            pollUntil(
              () =>
                ResultAsync.fromSafePromise(deps.sandboxRunnerIdForThread(threadId)).map(
                  (runnerId) =>
                    runnerId && deps.presence?.isAvailable(runnerId) ? runnerId : null,
                ),
              {
                what: 'sandbox runner reconnection',
                timeoutMs: deps.connectTimeoutMs ?? 3 * 60_000,
                intervalMs: pollMs,
                signal,
                sleep: deps.sleep,
              },
            ).mapErr(sandboxError),
          )
          .andThen((runnerId) =>
            setState(row.threadId, 'running', { runnerId, error: null }).map(() => runnerId),
          )
          .orElse((error) => {
            // Expired disk or vanished machine: the thread must be re-provisioned.
            const lost =
              error.kind === 'sandbox' &&
              (error.cause === 'expired' || error.cause === 'not-found');
            return setState(row.threadId, lost ? 'lost' : 'failed', {
              error: error.message,
            }).andThen(() => errAsync<string, ProvisionError>(error));
          }),
      );
    },

    /**
     * Tear down the thread's sandbox for good (thread deleted): destroy the
     * machine, revoke its runner and drop the row. A machine the provider no
     * longer knows counts as destroyed. Any other failure keeps the row (state
     * `failed`) so the leak stays visible; the provider lifetime cap bounds it.
     */
    destroy(threadId: string): ResultAsync<void, ProvisionError> {
      return fromStore(deps.store.get(threadId)).andThen((row) => {
        if (!row) return okAsync<void, ProvisionError>(undefined);
        const sandboxId = row.sandboxId;
        const destroyed: ResultAsync<void, ProvisionError> = !sandboxId
          ? okAsync(undefined)
          : providerForConnection(deps.connections, row.userId, row.connectionId).andThen(
              ({ provider }) =>
                provider
                  .destroy({ providerId: provider.id, sandboxId })
                  .orElse((e) =>
                    e.kind === 'not-found' || e.kind === 'expired'
                      ? okAsync(undefined)
                      : errAsync(e),
                  )
                  .mapErr(sandboxError),
            );
        return destroyed
          .andThen(() =>
            ResultAsync.fromPromise(
              (async () => {
                const runnerId = row.runnerId ?? (await deps.sandboxRunnerIdForThread(threadId));
                if (runnerId) await deps.removeRunner?.(runnerId);
              })(),
              (e): ProvisionError => ({ kind: 'storage', message: String(e) }),
            ),
          )
          .andThen(() => fromStore(deps.store.remove(threadId)))
          .orElse((error) =>
            setState(threadId, 'failed', { error: `destroy failed: ${error.message}` }).andThen(
              () => errAsync<void, ProvisionError>(error),
            ),
          );
      });
    },
  };
}

export type ThreadSandboxControl = ReturnType<typeof createThreadSandboxControl>;
