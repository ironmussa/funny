/**
 * Counts Web Workers created and terminated by the client.
 *
 * Why this exists: `performance.memory` reports only the main isolate's heap.
 * Every worker has its own isolate, and WASM linear memory grows without ever
 * returning to the OS, so a worker-side leak is completely invisible to the
 * memory profiler's `heap.*` series. `performance.measureUserAgentSpecificMemory()`
 * would see all of it, but it requires cross-origin isolation, which Funny cannot
 * enable without `COEP: require-corp` (see the COOP note in
 * packages/server/src/index.ts). Counting worker lifetimes is the approximation
 * available to us: a live count that only grows points at the leak even though we
 * cannot size it from here.
 *
 * These are counts, not bytes. To size a worker, take a heap snapshot of its
 * target in DevTools > Memory.
 */

export interface WorkerCounters {
  created: number;
  terminated: number;
  live: number;
}

const byKind = new Map<string, { created: number; terminated: number }>();

function bucket(kind: string): { created: number; terminated: number } {
  const existing = byKind.get(kind);
  if (existing) return existing;
  const fresh = { created: 0, terminated: 0 };
  byKind.set(kind, fresh);
  return fresh;
}

export function recordWorkerCreated(kind: string): void {
  bucket(kind).created++;
}

export function recordWorkerTerminated(kind: string): void {
  bucket(kind).terminated++;
}

/**
 * Wraps a worker so its own `terminate()` is counted. Monaco disposes its
 * workers internally, so patching the instance is the only way to see it —
 * without this, `live` would only ever grow and mean nothing.
 */
export function trackWorker<T extends Worker>(kind: string, worker: T): T {
  recordWorkerCreated(kind);
  const terminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    recordWorkerTerminated(kind);
    terminate();
  };
  return worker;
}

export interface WorkerDiagnosticsSnapshot {
  totals: WorkerCounters;
  byKind: Record<string, WorkerCounters>;
}

export function getWorkerDiagnostics(): WorkerDiagnosticsSnapshot {
  const totals = { created: 0, terminated: 0, live: 0 };
  const kinds: Record<string, WorkerCounters> = {};

  for (const [kind, counts] of byKind) {
    const live = counts.created - counts.terminated;
    kinds[kind] = { ...counts, live };
    totals.created += counts.created;
    totals.terminated += counts.terminated;
    totals.live += live;
  }

  return { totals, byKind: kinds };
}

/** Test seam for resetting module-level counters between unit tests. */
export function resetWorkerDiagnosticsForTests(): void {
  byKind.clear();
}
