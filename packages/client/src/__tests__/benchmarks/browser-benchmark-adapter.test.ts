import { BENCHMARK_PROTOCOL_VERSION, type BenchmarkWorkloadName } from '@funny/client-benchmark';
import { describe, expect, test } from 'vitest';

import { createBrowserBenchmarkAdapter } from '@/benchmarks/browser-benchmark-adapter';

function adapter(runWorkload?: (name: BenchmarkWorkloadName) => Promise<never>) {
  return createBrowserBenchmarkAdapter({
    fixtureVersion: 'long-thread-v2',
    renderer: 'react-dom-chromium/virtual',
    featureInventory: { markdown: 250, code: 1, table: 1, toolCall: 1, diff: 1 },
    now: () => 10,
    runWorkload:
      runWorkload ??
      (async (name) => ({
        samples: [{ metric: name, value: 4, unit: 'ms', timestampMs: 11, valid: true }],
        diagnostics: { name },
        presentedAtMs: 12,
      })),
  });
}

describe('browser benchmark adapter', () => {
  test('accepts shared initialization commands and advertises capabilities', async () => {
    const events = await adapter().handleCommand({
      type: 'initialize',
      protocolVersion: BENCHMARK_PROTOCOL_VERSION,
      runId: 'run-1',
      fixtureVersion: 'long-thread-v2',
    });
    expect(events[0]?.type).toBe('ready');
    if (events[0]?.type !== 'ready') throw new Error('Expected ready event');
    expect(events[0].capabilities.capabilities.presentationAcknowledgement.status).toBe(
      'supported',
    );
  });

  test('emits started, presented, and completed events for a workload', async () => {
    const events = await adapter().handleCommand({
      type: 'run-workload',
      id: 'scroll-1',
      workload: 'scroll',
      measured: true,
    });
    expect(events.map((event) => event.type)).toEqual([
      'workload-started',
      'presented',
      'workload-completed',
    ]);
  });

  test('reports fixture mismatches and workload failures as protocol errors', async () => {
    const instance = adapter(async () => {
      throw new Error('viewport missing');
    });
    const mismatch = await instance.handleCommand({
      type: 'initialize',
      protocolVersion: BENCHMARK_PROTOCOL_VERSION,
      runId: 'run-1',
      fixtureVersion: 'old',
    });
    expect(mismatch[0]).toMatchObject({ type: 'error', code: 'fixture-version-mismatch' });
    const failed = await instance.handleCommand({
      type: 'run-workload',
      id: 'scroll-1',
      workload: 'scroll',
      measured: true,
    });
    expect(failed[1]).toMatchObject({ type: 'error', message: 'viewport missing' });
  });
});
