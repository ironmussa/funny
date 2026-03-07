/**
 * Telemetry client for api-acp — sends logs, metrics, and traces to Abbacchio.
 *
 * Enable by setting OTLP_ENDPOINT (defaults to http://localhost:4000).
 */

import { createClient, type AbbacchioClient, type SpanRecord } from '@abbacchio/transport';

const endpoint = process.env.OTLP_ENDPOINT || 'http://localhost:4000';
const enabled = !!process.env.OTLP_ENDPOINT;

export const telemetry: AbbacchioClient = createClient({
  endpoint,
  serviceName: 'funny-api-acp',
  enabled,
  batchSize: 5,
  interval: 2000,
});

/** Structured logger that sends to Abbacchio */
export const log = {
  info(msg: string, data?: Record<string, unknown>) {
    telemetry.add({ level: 30, msg, time: Date.now(), ...data });
  },
  warn(msg: string, data?: Record<string, unknown>) {
    telemetry.add({ level: 40, msg, time: Date.now(), ...data });
  },
  error(msg: string, data?: Record<string, unknown>) {
    telemetry.add({ level: 50, msg, time: Date.now(), ...data });
  },
  debug(msg: string, data?: Record<string, unknown>) {
    telemetry.add({ level: 20, msg, time: Date.now(), ...data });
  },
};

/** Record a metric (counter or gauge) */
export function metric(
  name: string,
  value: number,
  opts?: { type?: 'sum' | 'gauge'; unit?: string; attributes?: Record<string, unknown> },
) {
  telemetry.addMetric({
    name,
    value,
    type: opts?.type ?? 'sum',
    unit: opts?.unit,
    attributes: opts?.attributes,
  });
}

/** Generate a random hex string of given byte length */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Start a trace span — returns a function to call when the span ends */
export function startSpan(
  name: string,
  opts?: { traceId?: string; parentSpanId?: string; attributes?: Record<string, unknown> },
): { traceId: string; spanId: string; end: (status?: 'ok' | 'error', errorMsg?: string) => void } {
  const traceId = opts?.traceId ?? randomHex(16);
  const spanId = randomHex(8);
  const startTime = Date.now();

  return {
    traceId,
    spanId,
    end(status?: 'ok' | 'error', errorMsg?: string) {
      const endTime = Date.now();
      const span: SpanRecord = {
        traceId,
        spanId,
        parentSpanId: opts?.parentSpanId,
        name,
        startTimeUnixNano: String(startTime * 1_000_000),
        endTimeUnixNano: String(endTime * 1_000_000),
        attributes: {
          ...opts?.attributes,
          'duration.ms': endTime - startTime,
        },
        status: status === 'error' ? { code: 2, message: errorMsg } : { code: 1 },
      };
      telemetry.addSpan(span);
    },
  };
}
