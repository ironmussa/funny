import {
  BENCHMARK_PROTOCOL_VERSION,
  type BenchmarkCommand,
  type BenchmarkEvent,
  type BenchmarkWorkloadName,
  type MetricSample,
  type RendererFeatureInventory,
} from '@funny/client-benchmark';

import { GPUIX_BENCHMARK_CAPABILITIES } from './capabilities';

export interface GpuixWorkloadObservation {
  samples: MetricSample[];
  diagnostics: Record<string, string | number | boolean | null>;
}

export interface GpuixBenchmarkOperations {
  fixtureVersion: string;
  renderer: string;
  featureInventory: RendererFeatureInventory;
  now: () => number;
  runWorkload: (
    name: BenchmarkWorkloadName,
    measured: boolean,
  ) => Promise<GpuixWorkloadObservation>;
}

export function createGpuixBenchmarkAdapter(operations: GpuixBenchmarkOperations): {
  handleCommand: (command: BenchmarkCommand) => Promise<BenchmarkEvent[]>;
} {
  return {
    async handleCommand(command) {
      if (command.type === 'initialize') {
        if (command.fixtureVersion !== operations.fixtureVersion) {
          return [
            {
              type: 'error',
              code: 'fixture-version-mismatch',
              message: `Expected ${operations.fixtureVersion}; received ${command.fixtureVersion}`,
            },
          ];
        }
        return [
          {
            type: 'ready',
            protocolVersion: BENCHMARK_PROTOCOL_VERSION,
            renderer: operations.renderer,
            capabilities: GPUIX_BENCHMARK_CAPABILITIES,
            featureInventory: operations.featureInventory,
          },
        ];
      }
      if (command.type === 'shutdown') return [{ type: 'closed', reason: 'requested' }];
      const startedAt = operations.now();
      try {
        const observation = await operations.runWorkload(command.workload, command.measured);
        return [
          { type: 'workload-started', id: command.id, monotonicMs: startedAt },
          {
            type: 'workload-completed',
            id: command.id,
            samples: observation.samples,
            diagnostics: observation.diagnostics,
          },
        ];
      } catch (error) {
        return [
          { type: 'workload-started', id: command.id, monotonicMs: startedAt },
          {
            type: 'error',
            id: command.id,
            code: 'workload-failed',
            message: error instanceof Error ? error.message : String(error),
          },
        ];
      }
    },
  };
}
