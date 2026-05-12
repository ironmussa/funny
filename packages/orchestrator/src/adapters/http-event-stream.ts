/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Long-poll consumer of `/api/orchestrator/system/events`. Runs a single
 * loop in the orchestrator brain process; per-thread subscribers register
 * via `subscribe(threadId, handler)` and get woken when a matching event
 * arrives.
 *
 * The HTTP layer guarantees monotonic seq numbers; the stream remembers
 * the highest seq it has consumed so reconnects pick up cleanly.
 *
 * On transient fetch failures the loop backs off (default 1s) and retries
 * — losing up to `capacity` events on the server side is recoverable
 * because the brain reconciles full DB state on every tick.
 */

import type { DispatcherLogger } from '../dispatcher.js';
import type { HttpOrchestratorClient } from './http-client.js';

export interface EventStreamEvent {
  seq: number;
  kind: 'agent_terminal' | 'thread_stage';
  threadId: string;
  ts: number;
  payload: Record<string, unknown>;
}

export interface HttpEventStreamOptions {
  client: HttpOrchestratorClient;
  /** ms timeout passed to the long-poll request. Defaults to 25_000. */
  longPollTimeoutMs?: number;
  /** ms backoff between reconnect attempts after fetch error. Defaults to 1_000. */
  errorBackoffMs?: number;
  log?: DispatcherLogger;
}

const NS = 'http-event-stream';

type Handler = (event: EventStreamEvent) => void;

const NOOP_LOG: DispatcherLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class HttpEventStream {
  private readonly client: HttpOrchestratorClient;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private readonly log: DispatcherLogger;

  private cursor = 0;
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
    this.loopPromise = this.loop();
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
      this.abortCtrl = new AbortController();
      try {
        const result = await this.client.request<{
          events: EventStreamEvent[];
          nextSeq: number;
        }>('GET', '/events', {
          query: { since: this.cursor, timeoutMs: this.timeoutMs },
          signal: this.abortCtrl.signal,
        });
        for (const event of result.events) {
          this.dispatch(event);
          if (event.seq > this.cursor) this.cursor = event.seq;
        }
        if (result.nextSeq > this.cursor) this.cursor = result.nextSeq;
      } catch (err) {
        if (!this.running) break;
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn('Event stream fetch failed — backing off', {
          namespace: NS,
          error: message,
          cursor: this.cursor,
        });
        await new Promise((r) => setTimeout(r, this.backoffMs));
      }
      // Always yield to the macrotask queue between iterations so other
      // timers (including the test's stop() trigger) get a chance to run
      // even when the fetch above resolves synchronously.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  private dispatch(event: EventStreamEvent): void {
    const set = this.handlers.get(event.threadId);
    if (!set) return;
    for (const h of [...set]) h(event);
  }
}
