/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Telemetry helpers for funny-server — metrics and traces via Abbacchio OTLP.
 * Logs continue to go through Winston (logger.ts). This module adds metrics/traces.
 *
 * Enable by setting OTLP_ENDPOINT (e.g. http://localhost:4000).
 */

import { createClient, type AbbacchioClient, type SpanRecord } from '@abbacchio/transport';

import { getTelemetryConfig } from './telemetry-config.js';

const cfg = getTelemetryConfig();

export const telemetry: AbbacchioClient = createClient({
  endpoint: cfg.endpoint,
  serviceName: cfg.serverServiceName,
  enabled: cfg.enabled,
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

/** Record a histogram data point (uses OTLP native histogram via addHistogram) */
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

// ── Thread-scoped trace context ──────────────────────────────────
// Maps threadId → active trace context so that spans created across
// different modules (agent-runner, git handlers) share the same traceId.

export interface TraceContext {
  traceId: string;
  spanId: string;
}

const threadTraceMap = new Map<string, TraceContext>();

/** Set the active trace context for a thread */
export function setThreadTrace(threadId: string, ctx: TraceContext): void {
  threadTraceMap.set(threadId, ctx);
}

/** Get the active trace context for a thread (if any) */
export function getThreadTrace(threadId: string): TraceContext | undefined {
  return threadTraceMap.get(threadId);
}

/** Clear the trace context for a thread */
export function clearThreadTrace(threadId: string): void {
  threadTraceMap.delete(threadId);
}

/** Generate a random hex string of given byte length */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SpanHandle {
  traceId: string;
  spanId: string;
  /** Mutable — update before calling end() to change the recorded span name */
  name: string;
  /** Mutable — add/update attributes before calling end() */
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
