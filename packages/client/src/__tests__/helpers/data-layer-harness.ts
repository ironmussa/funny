import { cleanup } from '@testing-library/react';

import { createDataLayer, type DataLayer } from '@/data/data-layer';
import { replaceDataLayer } from '@/data/runtime';

/**
 * Test harness for the client data layer.
 *
 * Mock API modules the usual way (`vi.mock('@/lib/api/threads', …)` returning
 * `okAsync`/`errAsync`), then install a fresh layer per test so no collection
 * or cached query leaks between tests:
 *
 *   let layer: DataLayer;
 *   beforeEach(() => { layer = installTestDataLayer(); });
 *   afterEach(() => resetTestDataLayer());
 */
export function installTestDataLayer(userId: string | null = 'user-1'): DataLayer {
  const layer = createDataLayer({ userId });
  replaceDataLayer(layer);
  return layer;
}

/**
 * Dispose the current layer and install an anonymous one. Unmounts what the
 * test rendered first: a file's `afterEach` runs before Testing Library's
 * cleanup, and swapping the layer under mounted hooks re-renders every
 * subscriber outside act.
 */
export function resetTestDataLayer(): void {
  cleanup();
  replaceDataLayer(createDataLayer({ userId: null }));
}

/** A promise you resolve or reject by hand, for ordering fetches in a test. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks (sync commits, query-core notifications) run. */
export async function flushMicrotasks(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
