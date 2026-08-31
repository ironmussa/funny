import {
  BENCHMARK_CAPABILITY_SCHEMA_VERSION,
  supportedCapability,
  unsupportedCapability,
} from '../capabilities';
import {
  BENCHMARK_RESULT_SCHEMA_VERSION,
  parseBenchmarkResult,
  type BenchmarkResult,
  type MetricSummary,
  type WorkloadResult,
} from '../result-schema';

export function testSummary(
  metric: string,
  value: number,
  options: { unit?: MetricSummary['unit']; p95?: number; overBudget?: number } = {},
): MetricSummary {
  return {
    metric,
    unit: options.unit ?? 'ms',
    sampleCount: 20,
    invalidCount: 0,
    median: value,
    p95: options.p95 ?? value,
    p99: options.p95 ?? value,
    maximum: options.p95 ?? value,
    medianAbsoluteDeviation: 0.1,
    over16_67MsRatio: options.unit === 'bytes' ? null : (options.overBudget ?? 0.005),
    over8_33MsRatio: options.unit === 'bytes' ? null : 0.5,
    confidence95: { lower: value, upper: value, seed: 1 },
  };
}

function workload(name: WorkloadResult['name'], summaries: MetricSummary[]): WorkloadResult {
  return { name, status: 'complete', samples: [], summaries, diagnostics: {} };
}

export interface TestResultOptions {
  family?: BenchmarkResult['renderer']['family'];
  scrollP95?: number;
  overBudget?: number;
  switchMedian?: number;
  rss?: number;
  inputP95?: number;
  growth?: number;
  workloads?: WorkloadResult[];
}

export function createTestResult(options: TestResultOptions = {}): BenchmarkResult {
  const family = options.family ?? 'react-dom-chromium';
  const input = testSummary('input-to-present', 8, {
    p95: options.inputP95 ?? 10,
    overBudget: options.overBudget ?? 0.005,
  });
  const workloads = options.workloads ?? [
    workload('scroll', [
      testSummary('frame-time', 8, {
        p95: options.scrollP95 ?? 12,
        overBudget: options.overBudget ?? 0.005,
      }),
      input,
    ]),
    workload('thread-switch', [testSummary('switch-latency', options.switchMedian ?? 10)]),
    workload('streaming-update', [input]),
    workload('input-present', [input]),
    workload('repeated-navigation', [
      testSummary('rss-growth-ratio', options.growth ?? 0.02, { unit: 'percent' }),
    ]),
    workload('idle', [testSummary('process-tree-rss', options.rss ?? 100, { unit: 'bytes' })]),
  ];
  return parseBenchmarkResult({
    schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
    runId: `${family}-run`,
    status: 'complete',
    renderer: {
      family,
      variant: 'virtual',
      version: family === 'react-gpuix-gpui' ? '0.4.0' : '19.2.4',
      runtimeVersion: '1.4.0',
    },
    fixture: {
      version: 'long-thread-v2',
      checksums: { a: 'abc', b: 'def' },
      featureInventory: { markdown: 250, code: 60, table: 60, toolCall: 200, diff: 1 },
      messageCount: 500,
      toolCallCount: 200,
      retainedItemCount: 500,
      visibleItemCount: 12,
    },
    environment: {
      gitRevision: 'abcdef0',
      os: 'linux',
      architecture: 'x64',
      cpu: 'test cpu',
      gpu: 'test gpu',
      totalMemoryBytes: 1024,
      powerState: 'ac',
      viewport: { width: 1440, height: 900 },
      theme: 'benchmark-dark-v1',
      refreshTargetHz: 60,
      buildMode: 'release',
      startedAt: '2026-08-23T00:00:00.000Z',
      finishedAt: '2026-08-23T00:01:00.000Z',
    },
    configuration: { warmupCount: 1, measuredCount: 3, order: 'ABBA' },
    capabilities: {
      schemaVersion: BENCHMARK_CAPABILITY_SCHEMA_VERSION,
      renderer: family,
      capabilities: {
        frameTiming: supportedCapability('test'),
        presentationAcknowledgement: supportedCapability('test'),
        gpuMemory: unsupportedCapability('test'),
        screenshot: supportedCapability('test'),
        processSampling: supportedCapability('test'),
      },
    },
    workloads,
    validity: { valid: true, reasons: [] },
  });
}
