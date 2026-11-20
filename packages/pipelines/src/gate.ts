/**
 * Concurrency groups: the `ConcurrencyGate` port and its in-memory default.
 *
 * A node with `concurrency: { group, limit }` asks the run's gate for a slot
 * before it executes, and holds it until its work has stopped. The gate is
 * shared by every run of a host, so the limit applies across runs: "one
 * merge at a time per repository". Hosts that run on several servers
 * implement the port with leases; the in-memory gate serves one process.
 */

/** A request for one slot of a group. */
export interface SlotRequest {
  /** The group, already computed from the run's inputs. */
  group: string;
  /** The limit the node declares; the host may replace it. */
  limit: number;
  /** Who asks: `<runId>/<nodeId>/<visit>`. */
  holder: string;
  /** Aborted when the node no longer wants the slot (run cancelled, sibling failed). */
  signal: AbortSignal;
  /** Called once if the request has to wait for a slot. */
  onWait: () => void;
}

/** Gives the slot back. Calling it more than once has no effect. */
export type SlotRelease = () => void;

/** The host port that grants concurrency-group slots. */
export interface ConcurrencyGate {
  /**
   * Resolve with a release once a slot is granted. Reject when `signal`
   * aborts first; the request then leaves the queue.
   */
  acquire(request: SlotRequest): Promise<SlotRelease>;
}

/** Host hooks for the in-memory gate. */
export interface MemoryGateOptions {
  /** Replace the declared limit of a group (e.g. from host settings). */
  resolveLimit?: (group: string, declared: number) => number;
  /** Order waiters: lower first; equal priorities keep arrival order. Default 0. */
  priority?: (holder: string) => number;
}

interface Waiter {
  holder: string;
  limit: number;
  priority: number;
  seq: number;
  grant: () => void;
}

interface Group {
  held: Set<symbol>;
  waiters: Waiter[];
}

/** An in-memory, FIFO (by priority) gate for one process. */
export function createMemoryConcurrencyGate(options: MemoryGateOptions = {}): ConcurrencyGate {
  const groups = new Map<string, Group>();
  let seq = 0;

  const groupOf = (name: string): Group => {
    let g = groups.get(name);
    if (!g) {
      g = { held: new Set(), waiters: [] };
      groups.set(name, g);
    }
    return g;
  };

  /** Grant slots to the first waiters while the group has room. */
  const pump = (name: string) => {
    const g = groups.get(name);
    if (!g) return;
    while (g.waiters.length > 0 && g.held.size < g.waiters[0].limit) {
      g.waiters.shift()!.grant();
    }
    if (g.held.size === 0 && g.waiters.length === 0) groups.delete(name);
  };

  return {
    acquire({ group, limit, holder, signal, onWait }) {
      if (signal.aborted) return Promise.reject(abortError());
      const resolved = Math.max(1, Math.floor(options.resolveLimit?.(group, limit) ?? limit));
      return new Promise<SlotRelease>((resolve, reject) => {
        const g = groupOf(group);
        const onAbort = () => {
          const i = g.waiters.indexOf(waiter);
          if (i >= 0) g.waiters.splice(i, 1);
          reject(abortError());
          pump(group);
        };
        const waiter: Waiter = {
          holder,
          limit: resolved,
          priority: options.priority?.(holder) ?? 0,
          seq: seq++,
          grant: () => {
            signal.removeEventListener('abort', onAbort);
            const token = Symbol(holder);
            g.held.add(token);
            resolve(() => {
              if (g.held.delete(token)) pump(group);
            });
          },
        };
        g.waiters.push(waiter);
        g.waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
        signal.addEventListener('abort', onAbort, { once: true });
        pump(group);
        if (g.waiters.includes(waiter)) onWait();
      });
    },
  };
}

function abortError(): Error {
  const error = new Error('The slot request was cancelled');
  error.name = 'AbortError';
  return error;
}

/** The process-wide gate runs use when their host passes none. */
export const defaultConcurrencyGate: ConcurrencyGate = createMemoryConcurrencyGate();
