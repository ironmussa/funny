import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getWorkerDiagnostics,
  resetWorkerDiagnosticsForTests,
  trackWorker,
} from './worker-diagnostics';

function fakeWorker(): Worker & { terminated: boolean } {
  const worker = {
    terminated: false,
    terminate() {
      worker.terminated = true;
    },
  };
  return worker as unknown as Worker & { terminated: boolean };
}

describe('worker diagnostics', () => {
  beforeEach(() => {
    resetWorkerDiagnosticsForTests();
  });

  it('counts a worker per kind and keeps it live until terminated', () => {
    trackWorker('monaco:typescript', fakeWorker());
    const second = trackWorker('monaco:typescript', fakeWorker());
    trackWorker('file-search', fakeWorker());

    expect(getWorkerDiagnostics()).toEqual({
      totals: { created: 3, terminated: 0, live: 3 },
      byKind: {
        'monaco:typescript': { created: 2, terminated: 0, live: 2 },
        'file-search': { created: 1, terminated: 0, live: 1 },
      },
    });

    second.terminate();

    expect(getWorkerDiagnostics().totals).toEqual({ created: 3, terminated: 1, live: 2 });
    expect(getWorkerDiagnostics().byKind['monaco:typescript']).toEqual({
      created: 2,
      terminated: 1,
      live: 1,
    });
  });

  it('still terminates the underlying worker', () => {
    // Monaco disposes its own workers; the patched method must call through or
    // we would leak the isolate we set out to measure.
    const worker = fakeWorker();
    trackWorker('monaco:editor', worker);

    worker.terminate();

    expect(worker.terminated).toBe(true);
  });

  it('returns a snapshot that later activity cannot mutate', () => {
    trackWorker('file-search', fakeWorker());
    const snapshot = getWorkerDiagnostics();

    trackWorker('file-search', fakeWorker());

    expect(snapshot.totals.created).toBe(1);
    expect(snapshot.byKind['file-search']).toEqual({ created: 1, terminated: 0, live: 1 });
  });

  it('reports empty totals before any worker is created', () => {
    expect(getWorkerDiagnostics()).toEqual({
      totals: { created: 0, terminated: 0, live: 0 },
      byKind: {},
    });
  });

  it('does not swallow a terminate that throws', () => {
    const worker = fakeWorker();
    worker.terminate = vi.fn(() => {
      throw new Error('already gone');
    });
    trackWorker('file-search', worker);

    expect(() => worker.terminate()).toThrow('already gone');
    // The count still moved: the caller asked for termination.
    expect(getWorkerDiagnostics().totals.terminated).toBe(1);
  });
});
