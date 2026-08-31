import {
  BENCHMARK_CAPABILITY_SCHEMA_VERSION,
  BENCHMARK_RESULT_SCHEMA_VERSION,
  BENCHMARK_THEME,
  BENCHMARK_WORKLOAD_NAMES,
  makeRendererBenchmarkFixtures,
  parseBenchmarkResult,
  unsupportedCapability,
  type BenchmarkResult,
} from '../../packages/client-benchmark/src/index';

export interface ControlledHostSupport {
  supported: boolean;
  reason?: string;
}

export function controlledHostSupport(hostPlatform: string): ControlledHostSupport {
  if (hostPlatform === 'linux' || hostPlatform === 'darwin') return { supported: true };
  return {
    supported: false,
    reason: `Controlled renderer profiling is unsupported on ${hostPlatform}`,
  };
}

interface UnsupportedResultOptions {
  platform: string;
  architecture: string;
  cpu: string;
  totalMemoryBytes: number;
  gitRevision: string;
  reason: string;
  timestamp?: string;
}

export function createUnsupportedGpuixResult(options: UnsupportedResultOptions): BenchmarkResult {
  const fixtures = makeRendererBenchmarkFixtures();
  const timestamp = options.timestamp ?? new Date().toISOString();
  const unavailable = () => unsupportedCapability(options.reason);
  return parseBenchmarkResult({
    schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
    runId: `gpuix-unsupported-${timestamp}`,
    status: 'unsupported',
    renderer: {
      family: 'react-gpuix-gpui',
      variant: 'native',
      version: 'react@19.2.4 + @gpuix/react@0.5.1 + @gpuix/native@0.5.1',
      runtimeVersion: `bun@${Bun.version}`,
    },
    fixture: {
      version: fixtures.fixtureVersion,
      checksums: { a: fixtures.a.checksum, b: fixtures.b.checksum },
      featureInventory: fixtures.a.featureInventory,
      messageCount: fixtures.a.counts.messages,
      toolCallCount: fixtures.a.counts.toolCalls,
      retainedItemCount: null,
      visibleItemCount: null,
    },
    environment: {
      gitRevision: options.gitRevision,
      os: options.platform,
      architecture: options.architecture,
      cpu: options.cpu,
      gpu: null,
      totalMemoryBytes: options.totalMemoryBytes,
      powerState: null,
      viewport: { width: 1440, height: 900 },
      theme: BENCHMARK_THEME,
      refreshTargetHz: 60,
      buildMode: 'release',
      startedAt: timestamp,
      finishedAt: timestamp,
    },
    configuration: { warmupCount: 0, measuredCount: 1, order: 'ABBA' },
    capabilities: {
      schemaVersion: BENCHMARK_CAPABILITY_SCHEMA_VERSION,
      renderer: 'gpuix',
      capabilities: {
        frameTiming: unavailable(),
        presentationAcknowledgement: unavailable(),
        gpuMemory: unavailable(),
        screenshot: unavailable(),
        processSampling: unavailable(),
      },
    },
    workloads: BENCHMARK_WORKLOAD_NAMES.map((name) => ({
      name,
      status: 'unsupported',
      samples: [],
      summaries: [],
      diagnostics: {},
      unsupportedReason: options.reason,
    })),
    validity: { valid: false, reasons: [options.reason] },
  });
}
