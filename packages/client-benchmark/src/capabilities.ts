export const BENCHMARK_CAPABILITY_SCHEMA_VERSION = 1 as const;

export const BENCHMARK_CAPABILITY_NAMES = [
  'frameTiming',
  'presentationAcknowledgement',
  'gpuMemory',
  'screenshot',
  'processSampling',
] as const;

export type BenchmarkCapabilityName = (typeof BENCHMARK_CAPABILITY_NAMES)[number];

export interface CapabilityEvidence {
  source: string;
  detail: string;
}

export type BenchmarkCapability =
  | {
      status: 'supported';
      source: string;
      evidence: CapabilityEvidence[];
    }
  | {
      status: 'unsupported';
      reason: string;
      evidence: CapabilityEvidence[];
    };

export interface BenchmarkCapabilities {
  schemaVersion: typeof BENCHMARK_CAPABILITY_SCHEMA_VERSION;
  renderer: string;
  capabilities: Record<BenchmarkCapabilityName, BenchmarkCapability>;
}

const evidenceSchema = z.object({ source: z.string().min(1), detail: z.string().min(1) });
const supportedCapabilitySchema = z.object({
  status: z.literal('supported'),
  source: z.string().min(1),
  evidence: z.array(evidenceSchema),
});
const unsupportedCapabilitySchema = z.object({
  status: z.literal('unsupported'),
  reason: z.string().min(1),
  evidence: z.array(evidenceSchema),
});

export const benchmarkCapabilitySchema = z.discriminatedUnion('status', [
  supportedCapabilitySchema,
  unsupportedCapabilitySchema,
]);

export const benchmarkCapabilitiesSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_CAPABILITY_SCHEMA_VERSION),
  renderer: z.string().min(1),
  capabilities: z.record(z.enum(BENCHMARK_CAPABILITY_NAMES), benchmarkCapabilitySchema),
});

export function supportedCapability(
  source: string,
  evidence: CapabilityEvidence[] = [],
): BenchmarkCapability {
  return { status: 'supported', source, evidence };
}

export function unsupportedCapability(
  reason: string,
  evidence: CapabilityEvidence[] = [],
): BenchmarkCapability {
  return { status: 'unsupported', reason, evidence };
}
import { z } from 'zod';
