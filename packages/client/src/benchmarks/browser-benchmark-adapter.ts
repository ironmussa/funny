import {
  BENCHMARK_CAPABILITY_SCHEMA_VERSION,
  BENCHMARK_PROTOCOL_VERSION,
  supportedCapability,
  unsupportedCapability,
  type BenchmarkCapabilities,
  type BenchmarkCommand,
  type BenchmarkEvent,
  type BenchmarkWorkloadName,
  type MetricSample,
  type RendererFeatureInventory,
} from '@funny/client-benchmark';

export const BROWSER_BENCHMARK_CAPABILITIES: BenchmarkCapabilities = {
  schemaVersion: BENCHMARK_CAPABILITY_SCHEMA_VERSION,
  renderer: 'react-dom-chromium',
  capabilities: {
    frameTiming: supportedCapability('requestAnimationFrame workload samples'),
    presentationAcknowledgement: supportedCapability('double requestAnimationFrame boundary'),
    gpuMemory: unsupportedCapability('Chromium does not expose portable per-process GPU memory'),
    screenshot: supportedCapability('Playwright page screenshot'),
    processSampling: supportedCapability('renderer orchestrator process-tree sampler'),
  },
};

export interface BrowserWorkloadObservation {
  samples: MetricSample[];
  diagnostics: Record<string, string | number | boolean | null>;
  presentedAtMs?: number;
}

export interface BrowserBenchmarkOperations {
  fixtureVersion: string;
  renderer: string;
  featureInventory: RendererFeatureInventory;
  now: () => number;
  runWorkload: (
    name: BenchmarkWorkloadName,
    measured: boolean,
  ) => Promise<BrowserWorkloadObservation>;
}

export interface BrowserBenchmarkAdapter {
  handleCommand: (command: BenchmarkCommand) => Promise<BenchmarkEvent[]>;
}

export function createBrowserBenchmarkAdapter(
  operations: BrowserBenchmarkOperations,
): BrowserBenchmarkAdapter {
  let presentationSequence = 0;
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
            capabilities: BROWSER_BENCHMARK_CAPABILITIES,
            featureInventory: operations.featureInventory,
          },
        ];
      }
      if (command.type === 'shutdown') return [{ type: 'closed', reason: 'requested' }];

      const startedAt = operations.now();
      try {
        const observation = await operations.runWorkload(command.workload, command.measured);
        const events: BenchmarkEvent[] = [
          { type: 'workload-started', id: command.id, monotonicMs: startedAt },
        ];
        if (observation.presentedAtMs !== undefined) {
          events.push({
            type: 'presented',
            id: command.id,
            sequence: presentationSequence++,
            monotonicMs: observation.presentedAtMs,
          });
        }
        events.push({
          type: 'workload-completed',
          id: command.id,
          samples: observation.samples,
          diagnostics: observation.diagnostics,
        });
        return events;
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
