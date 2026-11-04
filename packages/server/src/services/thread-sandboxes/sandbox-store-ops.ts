/**
 * Store and connection helpers shared by sandbox provisioning and control
 * (change thread-sandboxes): map store / connection failures onto
 * `ProvisionError` and update a thread's sandbox state.
 */

import type { ResultAsync } from 'neverthrow';

import type { SandboxProvider } from './contract.js';
import type { InfraConnectionError, InfraConnectionService } from './infra-connections.js';
import type { ProvisionError } from './thread-sandbox-service.js';
import type {
  ThreadSandboxRow,
  ThreadSandboxState,
  ThreadSandboxStore,
} from './thread-sandbox-store.js';

export function sandboxStoreOps(deps: { store: ThreadSandboxStore; pollMs?: number }) {
  const fromStore = <T>(r: ResultAsync<T, string>) =>
    r.mapErr((message): ProvisionError => ({ kind: 'storage', message }));
  const setState = (
    threadId: string,
    state: ThreadSandboxState,
    patch: Partial<ThreadSandboxRow> = {},
  ) => fromStore(deps.store.update(threadId, { ...patch, state }));
  return { pollMs: deps.pollMs ?? 2_000, fromStore, setState };
}

/** A live provider client for the user's connection; failures become `connection`. */
export function providerForConnection(
  connections: Pick<InfraConnectionService, 'providerFor'>,
  userId: string,
  connectionId: string,
): ResultAsync<{ provider: SandboxProvider }, ProvisionError> {
  return connections
    .providerFor(userId, connectionId)
    .mapErr((e: InfraConnectionError): ProvisionError => ({
      kind: 'connection',
      message: e.message,
    }));
}
