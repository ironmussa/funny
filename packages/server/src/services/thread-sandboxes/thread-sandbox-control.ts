/**
 * Stop and resume of a thread's sandbox (change thread-sandboxes). Separate from
 * provisioning so the idle stopper and wake-on-demand need only a provider
 * connection, the store and runner presence.
 */

import { errAsync, ResultAsync } from 'neverthrow';

import type { SandboxError, SandboxHandle, SandboxProvider } from './contract.js';
import type { InfraConnectionError, InfraConnectionService } from './infra-connections.js';
import { pollUntil } from './poll.js';
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
}

export const sandboxError = (error: SandboxError): ProvisionError => ({
  kind: 'sandbox',
  message: error.message,
  cause: error.kind,
});

export function createThreadSandboxControl(deps: ThreadSandboxControlDeps) {
  const pollMs = deps.pollMs ?? 2_000;
  const fromStore = <T>(r: ResultAsync<T, string>) =>
    r.mapErr((message): ProvisionError => ({ kind: 'storage', message }));
  const setState = (
    threadId: string,
    state: ThreadSandboxState,
    patch: Partial<ThreadSandboxRow> = {},
  ) => fromStore(deps.store.update(threadId, { ...patch, state }));

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
      return deps.connections
        .providerFor(row.userId, row.connectionId)
        .mapErr((e: InfraConnectionError): ProvisionError => ({
          kind: 'connection',
          message: e.message,
        }))
        .andThen(({ provider }) => run(row, provider, { providerId: provider.id, sandboxId }));
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
              .resume(handle, { lifetimeMs: deps.lifetimeMs ?? 4 * 60 * 60_000 })
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
  };
}

export type ThreadSandboxControl = ReturnType<typeof createThreadSandboxControl>;
