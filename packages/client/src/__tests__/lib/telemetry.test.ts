import { describe, test, expect } from 'vitest';

import { startSpan, metric } from '@/lib/telemetry';

// These tests run in disabled mode (no VITE_OTLP_ENDPOINT set),
// so they verify the graceful no-op / fallback behavior.

describe('startSpan (disabled mode)', () => {
  test('returns SpanHandle with traceId and spanId', () => {
    const span = startSpan('test-span');
    expect(span.traceId).toBeDefined();
    expect(span.spanId).toBeDefined();
  });

  test('traceId is 32 hex characters', () => {
    const span = startSpan('test-span');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('spanId is 16 hex characters', () => {
    const span = startSpan('test-span');
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  test('traceparent follows W3C format', () => {
    const span = startSpan('test-span');
    expect(span.traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
  });

  test('end() does not throw', () => {
    const span = startSpan('test-span');
    expect(() => span.end()).not.toThrow();
    expect(() => span.end('OK')).not.toThrow();
    expect(() => span.end('ERROR', 'some error')).not.toThrow();
  });

  test('uses provided traceId when given', () => {
    const customTrace = 'a'.repeat(32);
    const span = startSpan('test-span', { traceId: customTrace });
    expect(span.traceId).toBe(customTrace);
  });

  test('generates unique traceId per call', () => {
    const span1 = startSpan('span-1');
    const span2 = startSpan('span-2');
    expect(span1.traceId).not.toBe(span2.traceId);
  });

  test('generates unique spanId per call', () => {
    const span1 = startSpan('span-1');
    const span2 = startSpan('span-2');
    expect(span1.spanId).not.toBe(span2.spanId);
  });
});

describe('metric (disabled mode)', () => {
  test('does not throw when called with valid args', () => {
    expect(() => metric('test.counter', 1)).not.toThrow();
  });

  test('accepts optional type and attributes', () => {
    expect(() =>
      metric('test.gauge', 42, { type: 'gauge', attributes: { env: 'test' } }),
    ).not.toThrow();
  });
});
