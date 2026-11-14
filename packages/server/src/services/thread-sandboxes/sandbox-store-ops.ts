/**
 * Connection helper shared by sandbox provisioning and control (change
 * thread-sandboxes): a provider client with failures mapped onto
 * `ProvisionError`.
 */

import type { SandboxProvider } from '@funny/sandbox';
import type { ResultAsync } from 'neverthrow';

import type { InfraConnectionError, InfraConnectionService } from './infra-connections.js';
import type { ProvisionError } from './thread-sandbox-service.js';

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
