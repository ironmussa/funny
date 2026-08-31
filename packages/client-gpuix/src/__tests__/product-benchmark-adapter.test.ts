import { describe, expect, test } from 'bun:test';

import {
  BENCHMARK_PROTOCOL_VERSION,
  makeRendererBenchmarkFixtures,
  parseBenchmarkEvent,
} from '@funny/client-benchmark';

import { createProductBenchmarkAdapter } from '../benchmark/product-adapter';

describe('GPUIX product benchmark adapter', () => {
  test('reuses the renderer-neutral protocol and keeps presentation claims unsupported', async () => {
    const fixture = makeRendererBenchmarkFixtures().a;
    const workloads: string[] = [];
    const adapter = createProductBenchmarkAdapter({
      fixtureVersion: fixture.fixtureVersion,
      featureInventory: fixture.featureInventory,
      now: () => 42,
      async runWorkload(name) {
        workloads.push(name);
        return {
          samples: [],
          diagnostics: {
            checksum: fixture.checksum,
            retainedItemCount: fixture.messages.length,
            visibleItemCount: null,
          },
        };
      },
    });
    const ready = await adapter.handleCommand({
      type: 'initialize',
      protocolVersion: BENCHMARK_PROTOCOL_VERSION,
      runId: 'run-1',
      fixtureVersion: fixture.fixtureVersion,
    });
    expect(ready[0]).toMatchObject({
      type: 'ready',
      capabilities: {
        capabilities: {
          frameTiming: { status: 'unsupported' },
          presentationAcknowledgement: { status: 'unsupported' },
        },
      },
    });
    const events = await adapter.handleCommand({
      type: 'run-workload',
      id: 'nav',
      workload: 'repeated-navigation',
      measured: true,
    });
    expect(events.map((event) => parseBenchmarkEvent(JSON.stringify(event)).type)).toEqual([
      'workload-started',
      'workload-completed',
    ]);
    expect(workloads).toEqual(['repeated-navigation']);
  });

  test('is absent from the production entry dependency graph', async () => {
    const source = await Bun.file(new URL('../main.ts', import.meta.url)).text();
    expect(source).not.toContain('benchmark/product-adapter');
  });
});
