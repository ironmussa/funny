import { log } from '../../lib/logger.js';
import { metric, recordHistogram } from '../../lib/telemetry.js';

export type RunnerGrpcObservationEvent =
  | 'stream-opened'
  | 'stream-closed'
  | 'stream-rejected'
  | 'session-activated'
  | 'session-replaced'
  | 'heartbeat-expired'
  | 'operation-completed'
  | 'operation-failed'
  | 'event-receipt'
  | 'event-gap';

export interface RunnerGrpcObservation {
  event: RunnerGrpcObservationEvent;
  streamClass: 'control' | 'operations' | 'events' | 'tunnel' | 'terminal';
  status: string;
  runnerId?: string;
  correlationId?: string;
  protocolVersion?: string;
  sessionEpoch?: bigint | string;
  reconnectReason?: string;
  queueDepth?: number;
  receiptLag?: number;
  gapSize?: number;
  latencyMs?: number;
}

/**
 * Emits only an explicit transport-health allowlist. Callers cannot attach
 * metadata, credentials, request fields, or payload bodies to these signals.
 */
export function observeRunnerGrpc(observation: RunnerGrpcObservation): void {
  const protocolVersion = observation.protocolVersion ?? 'runner.v2';
  const metricAttributes = {
    protocolVersion,
    streamClass: observation.streamClass,
    event: observation.event,
    status: observation.status,
  };
  const logAttributes = {
    namespace: 'runner-grpc',
    ...metricAttributes,
    ...(observation.runnerId ? { runnerId: observation.runnerId } : {}),
    ...(observation.correlationId ? { correlationId: observation.correlationId } : {}),
    ...(observation.sessionEpoch !== undefined
      ? { sessionEpoch: String(observation.sessionEpoch) }
      : {}),
    ...(observation.reconnectReason ? { reconnectReason: observation.reconnectReason } : {}),
    ...(observation.queueDepth !== undefined ? { queueDepth: observation.queueDepth } : {}),
    ...(observation.receiptLag !== undefined ? { receiptLag: observation.receiptLag } : {}),
    ...(observation.gapSize !== undefined ? { gapSize: observation.gapSize } : {}),
    ...(observation.latencyMs !== undefined ? { latencyMs: observation.latencyMs } : {}),
  };

  metric('runner.grpc.transport.events', 1, { attributes: metricAttributes });
  if (observation.queueDepth !== undefined) {
    metric('runner.grpc.queue.depth', observation.queueDepth, {
      type: 'gauge',
      attributes: metricAttributes,
    });
  }
  if (observation.receiptLag !== undefined) {
    metric('runner.grpc.receipt.lag', observation.receiptLag, {
      type: 'gauge',
      attributes: metricAttributes,
    });
  }
  if (observation.gapSize !== undefined) {
    recordHistogram('runner.grpc.gap.size', observation.gapSize, { attributes: metricAttributes });
  }
  if (observation.latencyMs !== undefined) {
    recordHistogram('runner.grpc.latency', observation.latencyMs, {
      unit: 'ms',
      attributes: metricAttributes,
    });
  }

  if (observation.status === 'ok') log.info('Runner gRPC transport observation', logAttributes);
  else log.warn('Runner gRPC transport observation', logAttributes);
}
