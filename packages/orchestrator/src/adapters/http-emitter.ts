/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * `OrchestratorEmitter` implementation that POSTs user-facing events to
 * `POST /api/orchestrator/system/emit` so the funny server can rebroadcast
 * via the existing WS relay. Fire-and-forget — failures are logged but not
 * surfaced (the brain's correctness doesn't depend on UI events landing).
 */

import type { OrchestratorEmitter, OrchestratorLogger } from '../service.js';
import type { HttpOrchestratorClient } from './http-client.js';

const NS = 'http-emitter';

export interface HttpOrchestratorEmitterOptions {
  client: HttpOrchestratorClient;
  log?: OrchestratorLogger;
}

const NOOP_LOG: OrchestratorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class HttpOrchestratorEmitter implements OrchestratorEmitter {
  private readonly client: HttpOrchestratorClient;
  private readonly log: OrchestratorLogger;

  constructor(opts: HttpOrchestratorEmitterOptions) {
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
