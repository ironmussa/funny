/**
 * Sandbox preparations in flight, per thread (change thread-sandboxes), so
 * deleting a thread — or shutting the server down — can cancel them. A
 * cancelled preparation stops at its next step and destroys the machine it
 * already created; otherwise a thread deleted during its 1–2 minute setup, or
 * a deploy landing mid-setup, would leave a machine behind.
 */

interface Tracked {
  controller: AbortController;
  /** Settles once the preparation (including its cleanup) has finished. */
  done: Promise<unknown>;
}

const inFlight = new Map<string, Tracked>();

/** Run `prepare` with a signal that `cancelProvision(threadId)` aborts. */
export function withProvisionTracking<T>(
  threadId: string,
  prepare: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const tracked: Tracked = { controller: new AbortController(), done: Promise.resolve() };
  const run = (async () => {
    try {
      return await prepare(tracked.controller.signal);
    } finally {
      if (inFlight.get(threadId) === tracked) inFlight.delete(threadId);
    }
  })();
  tracked.done = run.catch(() => undefined);
  inFlight.set(threadId, tracked);
  return run;
}

/** Cancel the thread's preparation, if any. Returns whether one was running. */
export function cancelProvision(threadId: string): boolean {
  const tracked = inFlight.get(threadId);
  if (!tracked) return false;
  tracked.controller.abort();
  inFlight.delete(threadId);
  return true;
}

/**
 * Cancel every preparation (server shutdown) and wait up to `graceMs` for their
 * cleanups. Whatever does not finish in time is left for the startup reconciler.
 */
export async function cancelAllProvisions(graceMs: number): Promise<number> {
  const all = [...inFlight.values()];
  inFlight.clear();
  for (const tracked of all) tracked.controller.abort();
  if (all.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(all.map((t) => t.done)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(timer);
  }
  return all.length;
}
