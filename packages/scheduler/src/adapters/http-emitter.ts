/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * `SchedulerEmitter` implementation that POSTs user-facing events to
 * `POST /api/scheduler/system/emit` so the funny server can rebroadcast
 * via the existing WS relay. Fire-and-forget — failures are logged but not
 * surfaced (the brain's correctness doesn't depend on UI events landing).
 */

import type { SchedulerEmitter, SchedulerLogger } from '../service.js';
import type { HttpSchedulerClient } from './http-client.js';

const NS = 'http-emitter';

export interface HttpSchedulerEmitterOptions {
  client: HttpSchedulerClient;
  log?: SchedulerLogger;
}

const NOOP_LOG: SchedulerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class HttpSchedulerEmitter implements SchedulerEmitter {
  private readonly client: HttpSchedulerClient;
  private readonly log: SchedulerLogger;

  constructor(opts: HttpSchedulerEmitterOptions) {
    this.client = opts.client;
    this.log = opts.log ?? NOOP_LOG;
  }

  emitToUser(userId: string, type: string, data: Record<string, unknown>): void {
    void this.client.post('/emit', { userId, type, data }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('emit failed', { namespace: NS, userId, type, error: message });
    });
  }
}
