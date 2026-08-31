import { z } from 'zod';

import { benchmarkCapabilitiesSchema } from './capabilities';
import { BENCHMARK_WORKLOAD_NAMES } from './workloads';

export const BENCHMARK_RESULT_SCHEMA_VERSION = 1 as const;
export const BENCHMARK_THEME = 'benchmark-dark-v1' as const;

export const rendererFeatureInventorySchema = z.object({
  markdown: z.number().int().nonnegative(),
  code: z.number().int().nonnegative(),
  table: z.number().int().nonnegative(),
  toolCall: z.number().int().nonnegative(),
  diff: z.number().int().nonnegative(),
});

export const metricSampleSchema = z.object({
  metric: z.string().min(1),
  value: z.number().finite(),
  unit: z.enum(['ms', 'bytes', 'bytes-per-second', 'percent', 'count']),
  timestampMs: z.number().finite(),
  valid: z.boolean(),
  reason: z.string().min(1).optional(),
});

export const metricSummarySchema = z.object({
  metric: z.string().min(1),
  unit: z.enum(['ms', 'bytes', 'bytes-per-second', 'percent', 'count']),
  sampleCount: z.number().int().nonnegative(),
  invalidCount: z.number().int().nonnegative(),
  median: z.number().finite().nullable(),
  p95: z.number().finite().nullable(),
  p99: z.number().finite().nullable(),
  maximum: z.number().finite().nullable(),
  medianAbsoluteDeviation: z.number().finite().nullable(),
  over16_67MsRatio: z.number().min(0).max(1).nullable(),
  over8_33MsRatio: z.number().min(0).max(1).nullable(),
  confidence95: z
    .object({ lower: z.number().finite(), upper: z.number().finite(), seed: z.number().int() })
    .nullable(),
});

const diagnosticValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const workloadResultSchema = z.object({
  name: z.enum(BENCHMARK_WORKLOAD_NAMES),
  status: z.enum(['complete', 'unsupported', 'failed']),
  samples: z.array(metricSampleSchema),
  summaries: z.array(metricSummarySchema),
  diagnostics: z.record(z.string(), diagnosticValueSchema),
  unsupportedReason: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

export const benchmarkResultSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_RESULT_SCHEMA_VERSION),
  runId: z.string().min(1),
  status: z.enum(['complete', 'unsupported', 'failed']),
  renderer: z.object({
    family: z.enum(['react-dom-chromium', 'react-gpuix-gpui']),
    variant: z.string().min(1),
    version: z.string().min(1),
    runtimeVersion: z.string().min(1),
  }),
  fixture: z.object({
    version: z.string().min(1),
    checksums: z.object({ a: z.string().min(1), b: z.string().min(1) }),
    featureInventory: rendererFeatureInventorySchema,
    messageCount: z.number().int().positive(),
    toolCallCount: z.number().int().nonnegative(),
    retainedItemCount: z.number().int().nonnegative().nullable(),
    visibleItemCount: z.number().int().nonnegative().nullable(),
  }),
  environment: z.object({
    gitRevision: z.string().min(1),
    os: z.string().min(1),
    architecture: z.string().min(1),
    cpu: z.string().min(1),
    gpu: z.string().min(1).nullable(),
    totalMemoryBytes: z.number().int().positive(),
    powerState: z.string().min(1).nullable(),
    viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    theme: z.literal(BENCHMARK_THEME),
    refreshTargetHz: z.number().positive(),
    buildMode: z.literal('release'),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1),
  }),
  configuration: z.object({
    warmupCount: z.number().int().nonnegative(),
    measuredCount: z.number().int().positive(),
    order: z.enum(['ABBA', 'BAAB']),
  }),
  capabilities: benchmarkCapabilitiesSchema,
  workloads: z.array(workloadResultSchema),
  validity: z.object({ valid: z.boolean(), reasons: z.array(z.string().min(1)) }),
});

export type BenchmarkResult = z.infer<typeof benchmarkResultSchema>;
export type MetricSample = z.infer<typeof metricSampleSchema>;
export type MetricSummary = z.infer<typeof metricSummarySchema>;
export type WorkloadResult = z.infer<typeof workloadResultSchema>;

export function parseBenchmarkResult(value: unknown): BenchmarkResult {
  const parsed = benchmarkResultSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`Invalid benchmark result: ${z.prettifyError(parsed.error)}`);
}
