import {
  BENCHMARK_PROTOCOL_VERSION,
  unsupportedCapability,
  supportedCapability,
  type BenchmarkCapabilities,
  type BenchmarkCommand,
  type BenchmarkEvent,
  type BenchmarkWorkloadName,
  type MetricSample,
  type RendererFeatureInventory,
} from '@funny/client-benchmark';

export const GPUIX_PRODUCT_BENCHMARK_CAPABILITIES: BenchmarkCapabilities = {
  schemaVersion: 1,
  renderer: 'react-gpuix-gpui-product',
  capabilities: {
    frameTiming: unsupportedCapability(
      'GPUIX 0.5 exposes aggregate draw statistics but no presented-frame samples',
    ),
    presentationAcknowledgement: unsupportedCapability(
      'GPUIX 0.5 has no verified public presentation acknowledgement',
    ),
    gpuMemory: unsupportedCapability('GPUIX 0.5 exposes no portable GPU-memory counter'),
    screenshot: supportedCapability('GPUIX native renderer captureScreenshot on supported hosts'),
    processSampling: supportedCapability('External process-tree sampler'),
  },
};

export interface ProductWorkloadObservation {
  samples: MetricSample[];
  diagnostics: Record<string, string | number | boolean | null>;
}

export interface ProductBenchmarkOperations {
  fixtureVersion: string;
  featureInventory: RendererFeatureInventory;
  now(): number;
  runWorkload(name: BenchmarkWorkloadName, measured: boolean): Promise<ProductWorkloadObservation>;
}

export function createProductBenchmarkAdapter(operations: ProductBenchmarkOperations) {
  return {
    async handleCommand(command: BenchmarkCommand): Promise<BenchmarkEvent[]> {
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
            renderer: GPUIX_PRODUCT_BENCHMARK_CAPABILITIES.renderer,
            capabilities: GPUIX_PRODUCT_BENCHMARK_CAPABILITIES,
            featureInventory: operations.featureInventory,
          },
        ];
      }
      if (command.type === 'shutdown') return [{ type: 'closed', reason: 'requested' }];
      const startedAt = operations.now();
      try {
        const result = await operations.runWorkload(command.workload, command.measured);
        return [
          { type: 'workload-started', id: command.id, monotonicMs: startedAt },
          { type: 'workload-completed', id: command.id, ...result },
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
