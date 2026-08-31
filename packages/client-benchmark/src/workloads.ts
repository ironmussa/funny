export const BENCHMARK_WORKLOAD_NAMES = [
  'cold-ready',
  'idle',
  'scroll',
  'thread-switch',
  'streaming-update',
  'input-present',
  'repeated-navigation',
] as const;

export type BenchmarkWorkloadName = (typeof BENCHMARK_WORKLOAD_NAMES)[number];

export interface BenchmarkWorkload {
  name: BenchmarkWorkloadName;
  description: string;
  durationMs?: number;
  steps?: number;
  switches?: number;
  requiresPresentation: boolean;
}

export const BENCHMARK_WORKLOADS: Readonly<Record<BenchmarkWorkloadName, BenchmarkWorkload>> = {
  'cold-ready': {
    name: 'cold-ready',
    description: 'Spawn to first complete thread presentation',
    requiresPresentation: true,
  },
  idle: {
    name: 'idle',
    description: 'Quiescent process sampling',
    durationMs: 60_000,
    requiresPresentation: false,
  },
  scroll: {
    name: 'scroll',
    description: 'Deterministic full-thread scroll sweep',
    steps: 41,
    requiresPresentation: true,
  },
  'thread-switch': {
    name: 'thread-switch',
    description: 'Switch between fixture threads A and B',
    requiresPresentation: true,
  },
  'streaming-update': {
    name: 'streaming-update',
    description: 'Append and update deterministic streamed content',
    steps: 20,
    requiresPresentation: true,
  },
  'input-present': {
    name: 'input-present',
    description: 'Controlled state input to confirmed presentation',
    steps: 20,
    requiresPresentation: true,
  },
  'repeated-navigation': {
    name: 'repeated-navigation',
    description: 'Alternating thread switches followed by quiescent sampling',
    switches: 100,
    requiresPresentation: false,
  },
};
