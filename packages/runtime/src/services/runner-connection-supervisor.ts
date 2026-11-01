import type { WSEvent } from '@funny/shared';
import { RUNNER_GRPC_WS_PATH } from '@funny/shared/runner-protocol';

import type { GrpcTeamTransport } from './grpc-team-transport.js';

export type RunnerConnectionOptions = ConstructorParameters<typeof GrpcTeamTransport>[0];

export interface SupervisedRunnerTransport {
  start(): void;
  shutdown(reason?: string): void;
  request(eventType: string, input: Record<string, any>): Promise<any>;
  publish(event: WSEvent): void;
}

export type RunnerTransportFactory = (
  options: RunnerConnectionOptions,
) => SupervisedRunnerTransport;

/**
 * The runner gRPC endpoint: `RUNNER_GRPC_ENDPOINT` when set (private network,
 * e.g. `server.railway.internal:50051`), otherwise the WebSocket carrier on the
 * `TEAM_SERVER_URL` origin — so a runner outside the private network needs no
 * extra configuration.
 */
export function requireRunnerGrpcEndpoint(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const endpoint = env.RUNNER_GRPC_ENDPOINT?.trim();
  if (endpoint) return endpoint;
  const serverUrl = env.TEAM_SERVER_URL?.trim();
  if (serverUrl) {
    const url = new URL(serverUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = RUNNER_GRPC_WS_PATH;
    url.search = '';
    url.hash = '';
    return url.toString();
  }
  throw new Error(
    'RUNNER_GRPC_ENDPOINT is required when TEAM_SERVER_URL is not set to derive the WebSocket carrier',
  );
}

/** Owns activation, reconnect callbacks delegated to gRPC, and deterministic shutdown. */
export class RunnerConnectionSupervisor {
  private transport: SupervisedRunnerTransport | null = null;

  constructor(
    readonly endpoint: string,
    private readonly createTransport: RunnerTransportFactory,
  ) {
    if (!endpoint.trim()) throw new Error('Runner gRPC endpoint must not be empty');
  }

  activate(options: Omit<RunnerConnectionOptions, 'endpoint'>): void {
    this.shutdown('runner connection replaced');
    this.transport = this.createTransport({ ...options, endpoint: this.endpoint });
    this.transport.start();
  }

  request(eventType: string, input: Record<string, any>): Promise<any> {
    if (!this.transport) throw new Error('gRPC runner transport not initialized');
    return this.transport.request(eventType, input);
  }

  publish(event: WSEvent): void {
    this.transport?.publish(event);
  }

  shutdown(reason?: string): void {
    this.transport?.shutdown(reason);
    this.transport = null;
  }

  isActive(): boolean {
    return this.transport !== null;
  }
}
