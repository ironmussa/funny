/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: composition-root
 * @domain layer: application
 *
 * Composition root for the standalone orchestrator binary.
 *
 * Wires `OrchestratorService` (the brain) with HTTP-backed adapters that
 * talk to a remote funny server via `/api/orchestrator/system/*`.
 *
 * Exposed as a function (`buildStandalone`) rather than top-level so
 * tests can compose with fake fetch implementations and assert wiring
 * without touching `process.env`. The actual binary entrypoint lives
 * in `bin/orchestrator.ts`.
 */

import { HttpOrchestratorClient } from './adapters/http-client.js';
import { HttpDispatcher } from './adapters/http-dispatcher.js';
import { HttpOrchestratorEmitter } from './adapters/http-emitter.js';
import { HttpEventStream } from './adapters/http-event-stream.js';
import { HttpOrchestratorRunRepository } from './adapters/http-run-repository.js';
import { HttpThreadQueryAdapter } from './adapters/http-thread-query.js';
import {
  OrchestratorService,
  defaultOrchestratorConfig,
  type OrchestratorConfig,
  type OrchestratorLogger,
} from './service.js';

export interface StandaloneConfig extends Partial<OrchestratorConfig> {
  /** Funny server URL, e.g. `http://localhost:3001`. */
  serverUrl: string;
  /** Shared secret (matches ORCHESTRATOR_AUTH_SECRET on the server). */
  authSecret: string;
  /** Optional pipeline name override. */
  pipelineName?: string;
  /** Long-poll request timeout for the events stream (ms). */
  longPollTimeoutMs?: number;
  /** Custom fetch impl (tests) — defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface StandaloneInstance {
  service: OrchestratorService;
  start(): void;
  stop(): Promise<void>;
}

export function buildStandalone(
  config: StandaloneConfig,
  log: OrchestratorLogger,
): StandaloneInstance {
  const client = new HttpOrchestratorClient({
    baseUrl: config.serverUrl,
    authSecret: config.authSecret,
    fetch: config.fetch,
  });

  const eventStream = new HttpEventStream({
    client,
    longPollTimeoutMs: config.longPollTimeoutMs,
    log,
  });

  const runRepo = new HttpOrchestratorRunRepository(client);
  const threadQuery = new HttpThreadQueryAdapter(client);
  const dispatcher = new HttpDispatcher({
    client,
    eventStream,
    log,
    pipelineName: config.pipelineName ?? null,
  });
  const emitter = new HttpOrchestratorEmitter({ client, log });

  const serviceConfig: OrchestratorConfig = {
    ...defaultOrchestratorConfig,
    ...config,
    enabled: config.enabled ?? true,
  };

  const service = new OrchestratorService({
    runRepo,
    threadQuery,
    dispatcher,
    emitter,
    config: serviceConfig,
    log,
  });

  let started = false;

  return {
    service,
    start(): void {
      if (started) return;
      started = true;
      eventStream.start();
      service.start();
      log.info('Standalone orchestrator started', {
        namespace: 'standalone',
        serverUrl: config.serverUrl,
        pollIntervalMs: serviceConfig.pollIntervalMs,
        reconcileIntervalMs: serviceConfig.reconcileIntervalMs,
      });
    },
    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      log.info('Standalone orchestrator stopping', { namespace: 'standalone' });
      await service.stop();
      await eventStream.stop();
      log.info('Standalone orchestrator stopped', { namespace: 'standalone' });
    },
  };
}
