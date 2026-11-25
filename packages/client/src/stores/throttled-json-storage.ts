import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';

export interface ThrottledJSONStorage<S> extends PersistStorage<S> {
  /** Write every pending value now (also runs on `pagehide`). */
  flush: () => void;
}

/** Every throttled storage, so a logout can drop their pending writes. */
const discarders = new Set<() => void>();

/**
 * Drop every pending throttled write and refuse new ones until the page
 * reloads. Called on logout before storage is cleared, so a deferred write
 * (or the `pagehide` flush of the logout reload) cannot put the previous
 * user's state back.
 */
export function discardPendingPersistWrites(): void {
  for (const discard of discarders) discard();
}

/** True for a string value. */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** True when a browser API (e.g. `requestIdleCallback`) exists as a function in this engine. */
function isCallable(value: unknown): value is (...args: never[]) => void {
  return typeof value === 'function';
}

/**
 * A zustand `persist` storage that coalesces writes.
 *
 * zustand's persist middleware calls `setItem` after EVERY `set`, even when
 * the partialized slice did not change. For a store that receives a stream of
 * updates (terminal output, metrics) that is a `JSON.stringify` and a
 * synchronous `localStorage.setItem` per chunk. This storage keeps only the
 * latest value, serializes it at most once per `delayMs`, and skips the write
 * when the stored value is already the same.
 *
 * Pending values are flushed on `pagehide`, so a reload keeps the last state.
 */
export function createThrottledJSONStorage<S>(
  getStorage: () => StateStorage,
  { delayMs = 1000 }: { delayMs?: number } = {},
): ThrottledJSONStorage<S> {
  const pending = new Map<string, StorageValue<S>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let discarded = false;

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    cancelTimer();
    if (pending.size === 0) return;
    const storage = getStorage();
    for (const [name, value] of pending) {
      const serialized = JSON.stringify(value);
      try {
        if (storage.getItem(name) === serialized) continue;
        storage.setItem(name, serialized);
      } catch {
        // Quota exceeded or storage unavailable: keep the in-memory state.
      }
    }
    pending.clear();
  };

  discarders.add(() => {
    discarded = true;
    cancelTimer();
    pending.clear();
  });

  if (typeof window !== 'undefined' && isCallable(window.addEventListener)) {
    window.addEventListener('pagehide', flush);
  }

  return {
    getItem: (name) => {
      const queued = pending.get(name);
      if (queued) return queued;
      const raw = getStorage().getItem(name);
      if (!isString(raw)) return null;
      try {
        return JSON.parse(raw) as StorageValue<S>;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      if (discarded) return;
      pending.set(name, value);
      timer ??= setTimeout(flush, delayMs);
    },
    removeItem: (name) => {
      pending.delete(name);
      getStorage().removeItem(name);
    },
    flush,
  };
}
