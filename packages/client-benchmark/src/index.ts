export {
  BENCHMARK_CAPABILITY_NAMES,
  BENCHMARK_CAPABILITY_SCHEMA_VERSION,
  benchmarkCapabilitiesSchema,
  benchmarkCapabilitySchema,
  supportedCapability,
  unsupportedCapability,
} from './capabilities';
export type {
  BenchmarkCapabilities,
  BenchmarkCapability,
  BenchmarkCapabilityName,
  CapabilityEvidence,
} from './capabilities';
export {
  BENCHMARK_PROTOCOL_VERSION,
  benchmarkCommandSchema,
  benchmarkEventSchema,
  encodeBenchmarkMessage,
  parseBenchmarkCommand,
  parseBenchmarkEvent,
} from './protocol';
export type { BenchmarkCommand, BenchmarkEvent } from './protocol';
export {
  BENCHMARK_RESULT_SCHEMA_VERSION,
  BENCHMARK_THEME,
  benchmarkResultSchema,
  metricSampleSchema,
  metricSummarySchema,
  parseBenchmarkResult,
  rendererFeatureInventorySchema,
  workloadResultSchema,
} from './result-schema';
export type { BenchmarkResult, MetricSample, MetricSummary, WorkloadResult } from './result-schema';
export { BENCHMARK_WORKLOAD_NAMES, BENCHMARK_WORKLOADS } from './workloads';
export type { BenchmarkWorkload, BenchmarkWorkloadName } from './workloads';
export {
  makeLongThread,
  makeRendererBenchmarkFixtures,
  benchmarkStateChecksum,
  RENDERER_BENCHMARK_FIXTURE_VERSION,
} from './fixtures/long-thread-fixture';
export type {
  FixtureMessage,
  FixtureToolCall,
  LongThreadFixture,
  LongThreadOptions,
  RendererBenchmarkFixture,
  RendererBenchmarkFixturePair,
  RendererBenchmarkState,
  RendererFeatureInventory,
} from './fixtures/long-thread-fixture';
export { validateFeatureEquivalence, validatePairedRuns } from './comparison';
export type { ValidationResult } from './comparison';
export {
  bootstrapMedianConfidence,
  median,
  medianAbsoluteDeviation,
  percentile,
  summarizeMetricSamples,
} from './statistics';
export { DEFAULT_VERDICT_POLICY, evaluateBenchmarkVerdict } from './verdict';
export type { BenchmarkVerdict, ScenarioVerdict, Verdict } from './verdict';
export {
  createRendererComparison,
  renderRendererComparisonMarkdown,
  RENDERER_COMPARISON_SCHEMA_VERSION,
  RENDERER_STACK_LABEL,
} from './report';
export type { ComparableMetric, RendererComparison } from './report';
