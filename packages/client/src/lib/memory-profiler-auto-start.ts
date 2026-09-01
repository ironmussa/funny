import type { MemoryProfilerApi, MemoryProfilerStatus } from '@abbacchio/browser-transport';

export const AUTO_MEMORY_PROFILE_OPTIONS = {
  intervalMs: 30_000,
  maxSamples: 1_440,
  label: 'memory-investigation',
} as const;

/** Starts a persisted memory run only when explicitly enabled by the environment. */
export function autoStartMemoryProfiler(
  profiler: Pick<MemoryProfilerApi, 'start'>,
  enabled: string | undefined,
): MemoryProfilerStatus | null {
  if (enabled !== 'true') return null;

  return profiler.start(AUTO_MEMORY_PROFILE_OPTIONS);
}
