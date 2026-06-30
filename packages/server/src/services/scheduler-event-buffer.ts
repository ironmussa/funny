/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: event-buffer
 * @domain layer: application
 *
 * Bounded ring buffer of scheduler-relevant events (agent terminals,
 * thread stage changes) tagged with monotonic sequence numbers, plus a
 * long-poll waiter that resolves when new events arrive.
 *
 * Used by `GET /api/scheduler/system/events?since=N&timeoutMs=...`
 * so the standalone scheduler brain can drive its `inFlight` map
 * without holding open in-process Promises.
 *
 * Bounded so we never accumulate forever — if a brain falls behind
 * past `capacity` events it must restart its sync from `nextSeq` and
 * accept that it will not see the dropped events (the brain reconciles
 * full DB state on every tick anyway, so this is recoverable).
 */

export type SchedulerEventKind = 'agent_terminal' | 'thread_stage';

export interface SchedulerEvent {
  /** Monotonic sequence number (assigned at publish). */
  seq: number;
  kind: SchedulerEventKind;
  threadId: string;
  /** ms since epoch */
  ts: number;
  payload: Record<string, unknown>;
}

export interface PublishInput {
  kind: SchedulerEventKind;
  threadId: string;
  payload: Record<string, unknown>;
}

export interface SchedulerEventBuffer {
  publish(input: PublishInput): SchedulerEvent;
  /** Returns events with `seq > since`, plus the highest seq currently held. */
  getSince(since: number): { events: SchedulerEvent[]; nextSeq: number };
  /**
   * Long-poll: resolves immediately if events with `seq > since` exist,
   * otherwise waits up to `timeoutMs` for the next `publish`. Always
   * returns the latest `nextSeq` so the caller can advance its cursor
   * even when nothing new arrived.
   */
  waitForEvents(
    since: number,
    timeoutMs: number,
  ): Promise<{
    events: SchedulerEvent[];
    nextSeq: number;
  }>;
}

const DEFAULT_CAPACITY = 1024;

export function createSchedulerEventBuffer(
  opts: { capacity?: number; now?: () => number } = {},
): SchedulerEventBuffer {
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const now = opts.now ?? (() => Date.now());

  const events: SchedulerEvent[] = [];
  let nextSeq = 1;
  const waiters: Array<() => void> = [];

  function trim(): void {
    if (events.length > capacity) {
      events.splice(0, events.length - capacity);
    }
  }

  function snapshot(since: number) {
    const out = events.filter((e) => e.seq > since);
    return { events: out, nextSeq: nextSeq - 1 };
  }

  return {
    publish(input) {
      const event: SchedulerEvent = {
        seq: nextSeq++,
        kind: input.kind,
        threadId: input.threadId,
        ts: now(),
        payload: input.payload,
      };
      events.push(event);
      trim();
      // Wake every waiter; each will call getSince and respond if applicable.
      const pending = waiters.splice(0);
      for (const w of pending) w();
      return event;
    },

    getSince(since) {
      return snapshot(since);
    },

    waitForEvents(since, timeoutMs) {
      const initial = snapshot(since);
      if (initial.events.length > 0 || timeoutMs <= 0) {
        return Promise.resolve(initial);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(onPublish);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(snapshot(since));
        }, timeoutMs);
        const onPublish = () => {
          clearTimeout(timer);
          resolve(snapshot(since));
        };
        waiters.push(onPublish);
      });
    },
  };
}

// ── Module-level singleton ────────────────────────────────────

let _buffer: SchedulerEventBuffer | null = null;

export function getSchedulerEventBuffer(): SchedulerEventBuffer {
  if (!_buffer) _buffer = createSchedulerEventBuffer();
  return _buffer;
}

/** Test seam. */
export function setSchedulerEventBuffer(buffer: SchedulerEventBuffer | null): void {
  _buffer = buffer;
}
