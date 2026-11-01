/**
 * Sandbox preparations in flight, per thread (change thread-sandboxes), so
 * deleting a thread can cancel its preparation. A cancelled preparation stops
 * at its next step and destroys the machine it already created — otherwise a
 * thread deleted during its 1–2 minute setup would leave a machine behind.
 */

const inFlight = new Map<string, AbortController>();

/** Run `prepare` with a signal that `cancelProvision(threadId)` aborts. */
export async function withProvisionTracking<T>(
  threadId: string,
  prepare: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  inFlight.set(threadId, controller);
  try {
    return await prepare(controller.signal);
  } finally {
    if (inFlight.get(threadId) === controller) inFlight.delete(threadId);
  }
}

/** Cancel the thread's preparation, if any. Returns whether one was running. */
export function cancelProvision(threadId: string): boolean {
  const controller = inFlight.get(threadId);
  if (!controller) return false;
  controller.abort();
  inFlight.delete(threadId);
  return true;
}
