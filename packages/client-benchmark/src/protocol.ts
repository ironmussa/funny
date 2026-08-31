import { z } from 'zod';

import { benchmarkCapabilitiesSchema } from './capabilities';
import { metricSampleSchema, rendererFeatureInventorySchema } from './result-schema';
import { BENCHMARK_WORKLOAD_NAMES } from './workloads';

export const BENCHMARK_PROTOCOL_VERSION = 1 as const;

const initializeCommandSchema = z.object({
  type: z.literal('initialize'),
  protocolVersion: z.literal(BENCHMARK_PROTOCOL_VERSION),
  runId: z.string().min(1),
  fixtureVersion: z.string().min(1),
});

const runWorkloadCommandSchema = z.object({
  type: z.literal('run-workload'),
  id: z.string().min(1),
  workload: z.enum(BENCHMARK_WORKLOAD_NAMES),
  measured: z.boolean(),
});

const shutdownCommandSchema = z.object({ type: z.literal('shutdown') });

export const benchmarkCommandSchema = z.discriminatedUnion('type', [
  initializeCommandSchema,
  runWorkloadCommandSchema,
  shutdownCommandSchema,
]);

const readyEventSchema = z.object({
  type: z.literal('ready'),
  protocolVersion: z.literal(BENCHMARK_PROTOCOL_VERSION),
  renderer: z.string().min(1),
  capabilities: benchmarkCapabilitiesSchema,
  featureInventory: rendererFeatureInventorySchema,
});

const workloadStartedEventSchema = z.object({
  type: z.literal('workload-started'),
  id: z.string().min(1),
  monotonicMs: z.number().finite(),
});

const presentedEventSchema = z.object({
  type: z.literal('presented'),
  id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  monotonicMs: z.number().finite(),
});

const workloadCompletedEventSchema = z.object({
  type: z.literal('workload-completed'),
  id: z.string().min(1),
  samples: z.array(metricSampleSchema),
  diagnostics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

const errorEventSchema = z.object({
  type: z.literal('error'),
  id: z.string().min(1).optional(),
  code: z.string().min(1),
  message: z.string().min(1),
});

const closedEventSchema = z.object({
  type: z.literal('closed'),
  reason: z.string().min(1),
});

export const benchmarkEventSchema = z.discriminatedUnion('type', [
  readyEventSchema,
  workloadStartedEventSchema,
  presentedEventSchema,
  workloadCompletedEventSchema,
  errorEventSchema,
  closedEventSchema,
]);

export type BenchmarkCommand = z.infer<typeof benchmarkCommandSchema>;
export type BenchmarkEvent = z.infer<typeof benchmarkEventSchema>;

function parseLine<T>(line: string, schema: z.ZodType<T>, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${String(error)}`, { cause: error });
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`Invalid ${label}: ${z.prettifyError(parsed.error)}`);
}

export function parseBenchmarkCommand(line: string): BenchmarkCommand {
  return parseLine(line, benchmarkCommandSchema, 'benchmark command');
}

export function parseBenchmarkEvent(line: string): BenchmarkEvent {
  return parseLine(line, benchmarkEventSchema, 'benchmark event');
}

export function encodeBenchmarkMessage(message: BenchmarkCommand | BenchmarkEvent): string {
  return `${JSON.stringify(message)}\n`;
}
