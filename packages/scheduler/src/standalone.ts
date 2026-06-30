/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: composition-root
 * @domain layer: application
 *
 * Composition root for the standalone scheduler binary.
 *
 * Wires `SchedulerService` (the brain) with HTTP-backed adapters that
 * talk to a remote funny server via `/api/scheduler/system/*`.
 *
 * Exposed as a function (`buildStandalone`) rather than top-level so
 * tests can compose with fake fetch implementations and assert wiring
 * without touching `process.env`. The actual binary entrypoint lives
 * in `bin/scheduler.ts`.
 */

import { HttpSchedulerClient } from './adapters/http-client.js';
import { HttpDispatcher } from './adapters/http-dispatcher.js';
import { HttpSchedulerEmitter } from './adapters/http-emitter.js';
import { HttpEventStream } from './adapters/http-event-stream.js';
import { HttpSchedulerRunRepository } from './adapters/http-run-repository.js';
import { HttpThreadQueryAdapter } from './adapters/http-thread-query.js';
import {
  SchedulerService,
  defaultSchedulerConfig,
  type SchedulerConfig,
  type SchedulerLogger,
} from './service.js';

export interface StandaloneConfig extends Partial<SchedulerConfig> {
  /** Funny server URL, e.g. `http://localhost:3001`. */
  serverUrl: string;
  /** Shared secret (matches SCHEDULER_AUTH_SECRET on the server). */
  authSecret: string;
  /** Optional pipeline name override. */
  pipelineName?: string;
  /** Long-poll request timeout for the events stream (ms). */
  longPollTimeoutMs?: number;
  /** Custom fetch impl (tests) — defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface StandaloneInstance {
  service: SchedulerService;
  start(): void;
  stop(): Promise<void>;
}

export function buildStandalone(
  config: StandaloneConfig,
  log: SchedulerLogger,
): StandaloneInstance {
  const client = new HttpSchedulerClient({
    baseUrl: config.serverUrl,
    authSecret: config.authSecret,
    fetch: config.fetch,
  });

  const eventStream = new HttpEventStream({
    client,
    longPollTimeoutMs: config.longPollTimeoutMs,
    log,
  });

  const runRepo = new HttpSchedulerRunRepository(client);
  const threadQuery = new HttpThreadQueryAdapter(client);
  const dispatcher = new HttpDispatcher({
    client,
    eventStream,
    log,
    pipelineName: config.pipelineName ?? null,
  });
  const emitter = new HttpSchedulerEmitter({ client, log });

  const serviceConfig: SchedulerConfig = {
    ...defaultSchedulerConfig,
    ...config,
    enabled: config.enabled ?? true,
  };

  const service = new SchedulerService({
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
      log.info('Standalone scheduler started', {
        namespace: 'standalone',
        serverUrl: config.serverUrl,
        pollIntervalMs: serviceConfig.pollIntervalMs,
        reconcileIntervalMs: serviceConfig.reconcileIntervalMs,
      });
    },
    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      log.info('Standalone scheduler stopping', { namespace: 'standalone' });
      await service.stop();
      await eventStream.stop();
      log.info('Standalone scheduler stopped', { namespace: 'standalone' });
    },
  };
}
