import { log } from '../../lib/logger.js';
import { metric, recordHistogram } from '../../lib/telemetry.js';

export interface BrowserV1Observation {
  event: 'negotiation' | 'decode' | 'operation' | 'dispatch' | 'recovery' | 'queue';
  status: string;
  trafficClass?: 'operations' | 'events' | 'terminal' | 'browserSession';
  representation?: 'legacy' | 'browser.v1' | 'shadow';
  transport?: string;
  logicalType?: string;
  reason?: string;
  payloadBytes?: number;
  latencyMs?: number;
  queueDepth?: number;
}

/** Payload-safe browser transport telemetry. No principal, resource, or body fields are accepted. */
export function observeBrowserV1(observation: BrowserV1Observation): void {
  const attributes = {
    protocolVersion: 'browser.v1',
    event: observation.event,
    status: observation.status,
    trafficClass: observation.trafficClass ?? undefined,
    representation: observation.representation ?? undefined,
    transport: observation.transport ?? undefined,
    logicalType: observation.logicalType ?? undefined,
    reason: observation.reason ?? undefined,
  };
  metric('browser.v1.transport.events', 1, { attributes });
  if (observation.payloadBytes !== undefined) {
    recordHistogram('browser.v1.payload.bytes', observation.payloadBytes, {
      unit: 'By',
      attributes,
    });
  }
  if (observation.latencyMs !== undefined) {
    recordHistogram('browser.v1.latency', observation.latencyMs, { unit: 'ms', attributes });
  }
  if (observation.queueDepth !== undefined) {
    metric('browser.v1.queue.depth', observation.queueDepth, {
      type: 'gauge',
      attributes,
    });
  }
  if (observation.status === 'ok' && observation.event === 'dispatch') return;
  const context = {
    namespace: 'browser-v1',
    ...attributes,
    payloadBytes: observation.payloadBytes ?? undefined,
    latencyMs: observation.latencyMs ?? undefined,
    queueDepth: observation.queueDepth ?? undefined,
  };
  if (observation.status === 'ok') log.info('Browser transport observation', context);
  else log.warn('Browser transport observation', context);
}
