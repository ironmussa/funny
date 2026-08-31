import { describe, expect, test } from 'bun:test';

import { BENCHMARK_PROTOCOL_VERSION } from '@funny/client-benchmark';

import { createGpuixBenchmarkAdapter } from '../adapter';

function adapter() {
  return createGpuixBenchmarkAdapter({
    fixtureVersion: 'long-thread-v2',
    renderer: 'react-gpuix-gpui/virtual',
    featureInventory: { markdown: 250, code: 1, table: 1, toolCall: 1, diff: 1 },
    now: () => 10,
    runWorkload: async (name) => ({
      samples: [{ metric: `${name}-mutation`, value: 1, unit: 'ms', timestampMs: 11, valid: true }],
      diagnostics: { finalStateChecksum: 'abc' },
    }),
  });
}

describe('GPUIX benchmark adapter', () => {
  test('advertises explicit unsupported frame capabilities', async () => {
    const events = await adapter().handleCommand({
      type: 'initialize',
      protocolVersion: BENCHMARK_PROTOCOL_VERSION,
      runId: 'run-1',
      fixtureVersion: 'long-thread-v2',
    });
    expect(events[0]?.type).toBe('ready');
    if (events[0]?.type !== 'ready') throw new Error('Expected ready event');
    expect(events[0].capabilities.capabilities.frameTiming.status).toBe('unsupported');
  });

  test('completes workloads without claiming a presented event', async () => {
    const events = await adapter().handleCommand({
      type: 'run-workload',
      id: 'scroll-1',
      workload: 'scroll',
      measured: true,
    });
    expect(events.map((event) => event.type)).toEqual(['workload-started', 'workload-completed']);
  });
});
