import { sleep as effectSleep } from '@funny/shared/async';
/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Long-poll consumer of `/api/scheduler/system/events`. Runs a single
 * loop in the scheduler brain process; per-thread subscribers register
 * via `subscribe(threadId, handler)` and get woken when a matching event
 * arrives.
 *
 * The HTTP layer guarantees monotonic seq numbers within one server
 * epoch; the stream remembers the highest seq it has consumed, and the
 * epoch it belongs to, so reconnects pick up cleanly. Seqs restart when
 * the server restarts: the stream sends its epoch with every poll, the
 * server answers a stale one from seq 0, and the stream resets its cursor
 * when the epoch in the answer changes.
 *
 * On transient fetch failures the loop backs off (default 1s) and retries
 * — losing up to `capacity` events on the server side is recoverable
 * because the brain reconciles full DB state on every tick.
 */

import type { DispatcherLogger } from '../dispatcher.js';
import type { HttpSchedulerClient } from './http-client.js';

export interface EventStreamEvent {
  seq: number;
  kind: 'agent_terminal' | 'thread_stage';
  threadId: string;
  ts: number;
  payload: Record<string, unknown>;
}

export interface HttpEventStreamOptions {
  client: HttpSchedulerClient;
  /** ms timeout passed to the long-poll request. Defaults to 25_000. */
  longPollTimeoutMs?: number;
  /** ms backoff between reconnect attempts after fetch error. Defaults to 1_000. */
  errorBackoffMs?: number;
  log?: DispatcherLogger;
}

const NS = 'http-event-stream';

interface EventPoll {
  events: EventStreamEvent[];
  nextSeq: number;
  /** Absent from servers older than the epoch fix. */
  epoch?: string;
}

type Handler = (event: EventStreamEvent) => void;

const NOOP_LOG: DispatcherLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class HttpEventStream {
  private readonly client: HttpSchedulerClient;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private readonly log: DispatcherLogger;

  private cursor = 0;
  /** Server epoch `cursor` belongs to; unknown until the first answer. */
  private epoch: string | undefined;
  private running = false;
  private abortCtrl: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();

  constructor(opts: HttpEventStreamOptions) {
    this.client = opts.client;
    this.timeoutMs = opts.longPollTimeoutMs ?? 25_000;
    this.backoffMs = opts.errorBackoffMs ?? 1_000;
    this.log = opts.log ?? NOOP_LOG;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortCtrl = new AbortController();
    const signal = this.abortCtrl.signal;
    this.loopPromise = this.loop().catch((error) => {
      if (!signal.aborted) throw error;
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortCtrl?.abort();
    if (this.loopPromise) await this.loopPromise;
    this.loopPromise = null;
  }

  /**
   * Subscribe to events for a single threadId. Returns an unsubscribe fn.
   * Multiple subscribers per thread are allowed.
   */
  subscribe(threadId: string, handler: Handler): () => void {
    let set = this.handlers.get(threadId);
    if (!set) {
      set = new Set();
      this.handlers.set(threadId, set);
    }
    set.add(handler);
    return () => {
      const current = this.handlers.get(threadId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(threadId);
    };
  }

  /** Snapshot of the current cursor — useful for tests / metrics. */
  currentCursor(): number {
    return this.cursor;
  }

  // ── Internal loop ────────────────────────────────────────

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        this.consume(await this.poll());
      } catch (err) {
        if (!this.running) break;
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('Event stream fetch failed — backing off', {
          namespace: NS,
          error: message,
          cursor: this.cursor,
        });
        await effectSleep(this.backoffMs, this.abortCtrl!.signal);
      }
      // Always yield to the macrotask queue between iterations so other
      // timers (including the test's stop() trigger) get a chance to run
      // even when the fetch above resolves synchronously.
      await effectSleep(0, this.abortCtrl!.signal);
    }
  }

  private poll(): Promise<EventPoll> {
    return this.client.request<EventPoll>('GET', '/events', {
      query: { since: this.cursor, timeoutMs: this.timeoutMs, epoch: this.epoch },
      signal: this.abortCtrl!.signal,
    });
  }

  private consume(result: EventPoll): void {
    if (result.epoch !== undefined) this.adoptEpoch(result.epoch);
    for (const event of result.events) {
      this.dispatch(event);
      if (event.seq > this.cursor) this.cursor = event.seq;
    }
    if (result.nextSeq > this.cursor) this.cursor = result.nextSeq;
  }

  /**
   * A new epoch means the server restarted and answered from its own start,
   * so seqs below the old cursor are new events, not replays.
   */
  private adoptEpoch(epoch: string): void {
    if (epoch === this.epoch) return;
    if (this.epoch !== undefined) {
      this.log.info('Server event sequence restarted — resetting cursor', {
        namespace: NS,
        previousCursor: this.cursor,
      });
    }
    this.cursor = 0;
    this.epoch = epoch;
  }

  private dispatch(event: EventStreamEvent): void {
    const set = this.handlers.get(event.threadId);
    if (!set) return;
    for (const h of [...set]) h(event);
  }
}
