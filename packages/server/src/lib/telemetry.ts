/**
 * Server telemetry — metrics and traces via Abbacchio OTLP.
 *
 * Mirrors the runtime telemetry module but uses service name `funny-server`,
 * so server-side spans/metrics show up under their own channel in Abbacchio.
 *
 * Enable by setting OTLP_ENDPOINT (e.g. http://localhost:4000).
 */

import { createClient, type AbbacchioClient, type SpanRecord } from '@abbacchio/transport';

const SERVICE_NAME = 'funny-server';
const endpoint = process.env.OTLP_ENDPOINT || 'http://localhost:4000';
const enabled = !!process.env.OTLP_ENDPOINT;

export const telemetry: AbbacchioClient = createClient({
  endpoint,
  serviceName: SERVICE_NAME,
  enabled,
  batchSize: 5,
  interval: 2000,
});

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

/** Record a histogram data point */
export function recordHistogram(
  name: string,
  value: number,
  opts?: { unit?: string; attributes?: Record<string, unknown> },
): void {
  telemetry.addHistogram({
    name,
    value,
    unit: opts?.unit,
    attributes: opts?.attributes,
  });
}

function randomHex(bytes: number): string {
  let out = '';
  for (let i = 0; i < bytes; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
}

export interface SpanHandle {
  traceId: string;
  spanId: string;
  name: string;
  attributes: Record<string, unknown>;
  durationMs: number;
  end: (status?: 'ok' | 'error', errorMsg?: string) => void;
}

/** Start a trace span — returns a handle whose name/attributes can be updated before end() */
export function startSpan(
  name: string,
  opts?: { traceId?: string; parentSpanId?: string; attributes?: Record<string, unknown> },
): SpanHandle {
  const traceId = opts?.traceId ?? randomHex(16);
  const spanId = randomHex(8);
  const startTime = Date.now();

  const handle: SpanHandle = {
    traceId,
    spanId,
    name,
    attributes: { ...opts?.attributes },
    durationMs: 0,
    end(status?: 'ok' | 'error', errorMsg?: string) {
      const endTime = Date.now();
      handle.durationMs = endTime - startTime;
      const span: SpanRecord = {
        traceId,
        spanId,
        parentSpanId: opts?.parentSpanId,
        name: handle.name,
        startTimeUnixNano: String(startTime * 1_000_000),
        endTimeUnixNano: String(endTime * 1_000_000),
        attributes: {
          ...handle.attributes,
          'duration.ms': handle.durationMs,
        },
        status: status === 'error' ? { code: 2, message: errorMsg } : { code: 1 },
      };
      telemetry.addSpan(span);
    },
  };
  return handle;
}
