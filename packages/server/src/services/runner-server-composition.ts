import { setBrowserEventSink } from './browser-events.js';
import {
  startRunnerGrpcEndpoint,
  type RunnerGrpcEndpoint,
  type RunnerGrpcEndpointOptions,
} from './grpc/runner-grpc-server.js';
import type {
  BrowserEventSink,
  RunnerPresencePort,
  RunnerRequestPort,
  RunnerTerminalPort,
} from './runner-ports.js';

export interface RunnerServerComposition {
  endpoint: RunnerGrpcEndpoint;
  requests: RunnerRequestPort;
  terminals: RunnerTerminalPort;
  presence: RunnerPresencePort;
  browserEvents: BrowserEventSink;
  shutdown(graceMs?: number): Promise<void>;
}

/** Plain composition root for the single production runner transport. */
export async function startRunnerServerComposition(
  browserEvents: BrowserEventSink,
  options?: RunnerGrpcEndpointOptions,
): Promise<RunnerServerComposition | null> {
  setBrowserEventSink(browserEvents);
  const endpoint = await startRunnerGrpcEndpoint(options);
  if (!endpoint) return null;
  return {
    endpoint,
    requests: endpoint.requests,
    terminals: endpoint.terminals,
    presence: endpoint.presence,
    browserEvents,
    shutdown: (graceMs) => endpoint.shutdown(graceMs),
  };
}
