import type { MemoryProfilerSample } from '@abbacchio/browser-transport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MEMORY_METRIC_PREFIX, publishMemorySample } from './memory-telemetry';
import { metric } from './telemetry';

vi.mock('./telemetry', () => ({ metric: vi.fn() }));

const metricMock = vi.mocked(metric);

function sampleWith(overrides: Partial<MemoryProfilerSample> = {}): MemoryProfilerSample {
  return {
    schemaVersion: 2,
    sessionId: 'run-1',
    sequence: 3,
    timestamp: '2026-07-24T12:00:00.000Z',
    elapsedMs: 90_000,
    kind: 'sample',
    label: null,
    heap: { usedBytes: 1_024, totalBytes: 2_048, limitBytes: 4_096 },
    dom: { elements: 10, canvases: 1, images: 2, xterms: 1, monacoEditors: 0 },
    values: {
      browserPanel: {
        totals: { framesReceived: 5, decodeFailures: 0, lastFrameAt: null },
        trackedSessions: [{ sessionId: 'a', framesReceived: 5 }],
      },
    },
    ...overrides,
  };
}

describe('publishMemorySample', () => {
  beforeEach(() => {
    metricMock.mockClear();
  });

  it('publishes heap, DOM, and Browser Panel counters as namespaced gauges', () => {
    publishMemorySample(sampleWith());

    const published = Object.fromEntries(
      metricMock.mock.calls.map(([name, value]) => [name, value]),
    );

    expect(published).toEqual({
      'client.memory.heap.used_bytes': 1_024,
      'client.memory.heap.total_bytes': 2_048,
      'client.memory.heap.limit_bytes': 4_096,
      'client.memory.dom.elements': 10,
      'client.memory.dom.canvases': 1,
      'client.memory.dom.images': 2,
      'client.memory.dom.xterms': 1,
      'client.memory.dom.monaco_editors': 0,
      'client.memory.browser_panel.totals.frames_received': 5,
      'client.memory.browser_panel.totals.decode_failures': 0,
    });
    expect(MEMORY_METRIC_PREFIX).toBe('client.memory');
  });

  it('records gauges tagged with the run session id so a run can be reassembled', () => {
    publishMemorySample(sampleWith({ kind: 'mark', label: 'browser-open' }));

    expect(metricMock).toHaveBeenCalledWith(expect.any(String), expect.any(Number), {
      type: 'gauge',
      attributes: {
        sessionId: 'run-1',
        kind: 'mark',
        sequence: '3',
        label: 'browser-open',
      },
    });
  });

  it('skips heap readings the browser does not expose', () => {
    publishMemorySample(
      sampleWith({ heap: { usedBytes: null, totalBytes: null, limitBytes: null } }),
    );

    const names = metricMock.mock.calls.map(([name]) => name);
    expect(names.some((name) => name.startsWith('client.memory.heap.'))).toBe(false);
    expect(names).toContain('client.memory.dom.elements');
  });
});
