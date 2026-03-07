/**
 * Client-side telemetry — provides metrics and traces for non-React code.
 * Uses @abbacchio/browser-transport client directly (singleton).
 *
 * Supports W3C Trace Context propagation: spans expose traceId/spanId so callers
 * can build a `traceparent` header for outgoing requests.
 */

import { createClient, type AbbacchioClient } from '@abbacchio/browser-transport';

const endpoint = import.meta.env.VITE_OTLP_ENDPOINT as string | undefined;
const enabled = !!endpoint;

let client: AbbacchioClient | null = null;

function getClient(): AbbacchioClient | null {
  if (!enabled) return null;
  if (!client) {
    client = createClient({
      endpoint: endpoint!,
      serviceName: 'funny-client',
      enabled: true,
    });
  }
  return client;
}

/** Generate a random hex string of given byte length */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Record a counter/gauge metric. */
export function metric(
  name: string,
  value: number,
  opts?: { type?: 'sum' | 'gauge'; attributes?: Record<string, string> },
): void {
  getClient()?.addMetric?.({
    name,
    value,
    type: opts?.type ?? 'sum',
    attributes: opts?.attributes,
  });
}

export interface SpanHandle {
  traceId: string;
  spanId: string;
  /** Build a W3C traceparent header value from this span */
  traceparent: string;
  end: (status?: 'OK' | 'ERROR', errorMsg?: string) => void;
}

const NOOP_SPAN: SpanHandle = {
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  traceparent: `00-${'0'.repeat(32)}-${'0'.repeat(16)}-00`,
  end: () => {},
};

/** Start a trace span — returns handle with traceId/spanId for context propagation. */
export function startSpan(
  name: string,
  opts?: {
    traceId?: string;
    parentSpanId?: string;
    attributes?: Record<string, string | number>;
  },
): SpanHandle {
  const c = getClient();
  const traceId = opts?.traceId ?? randomHex(16);
  const spanId = randomHex(8);

  if (!c) return { ...NOOP_SPAN, traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };

  const startTime = Date.now();

  return {
    traceId,
    spanId,
    traceparent: `00-${traceId}-${spanId}-01`,
    end(status: 'OK' | 'ERROR' = 'OK', errorMsg?: string) {
      c.addSpan?.({
        traceId,
        spanId,
        parentSpanId: opts?.parentSpanId,
        name,
        startTimeUnixNano: String(startTime * 1_000_000),
        endTimeUnixNano: String(Date.now() * 1_000_000),
        attributes: opts?.attributes as Record<string, string> | undefined,
        status: status === 'ERROR' ? { code: 2, message: errorMsg } : { code: 1 },
      });
    },
  };
}
