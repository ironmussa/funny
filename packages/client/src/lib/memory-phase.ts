/**
 * Annotates a memory profiling run with the application event that is about to
 * happen, so a stored run can be read back as phases instead of an anonymous
 * curve. See openwiki/operations/client-memory-diagnostics.md.
 *
 * This module deliberately imports nothing: app code calls it from hot paths and
 * from the main bundle, and pulling `@abbacchio/browser-transport` in here would
 * ship the profiler even in builds that exclude it. It reaches the profiler
 * through the global installed by `main.tsx` instead.
 */

/** Phases worth annotating. Keep this list short — every mark is a full sample. */
export type MemoryPhase =
  | 'thread-open'
  | 'browser-session-open'
  | 'browser-session-close'
  | 'terminal-open'
  | 'terminal-close';

interface MemoryProfilerHandle {
  mark?: (label: string) => unknown;
  status?: () => { running: boolean };
}

function getRunningProfiler(): MemoryProfilerHandle | null {
  const handle = (globalThis as typeof globalThis & { __funnyMemory?: MemoryProfilerHandle })
    .__funnyMemory;
  if (!handle?.mark || !handle.status) return null;
  // Only annotate an active run. `mark()` on an idle profiler would start
  // recording samples nobody asked for.
  return handle.status().running ? handle : null;
}

/**
 * Records a phase boundary if — and only if — a profiling run is active. A
 * no-op otherwise, which is the normal case: the profiler is never started on
 * its own.
 */
export function markMemoryPhase(phase: MemoryPhase): void {
  try {
    getRunningProfiler()?.mark?.(phase);
  } catch {
    // Diagnostics must never break the path they are observing.
  }
}
