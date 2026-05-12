#!/usr/bin/env bun
/**
 * Standalone funny orchestrator binary.
 *
 * Reads config from env, composes `OrchestratorService` with HTTP adapters
 * that talk to a remote funny server, and runs the poll/reconcile loops
 * until SIGTERM/SIGINT.
 *
 * Required env:
 *   FUNNY_SERVER_URL          base URL of the funny server (e.g. http://localhost:3001)
 *   ORCHESTRATOR_AUTH_SECRET  shared secret (must match server-side env)
 *
 * Optional env:
 *   ORCHESTRATOR_POLL_MS       (default 5000)
 *   ORCHESTRATOR_RECONCILE_MS  (default 30000)
 *   ORCHESTRATOR_MAX_GLOBAL    (default 16)
 *   ORCHESTRATOR_MAX_PER_USER  (default 4)
 *   ORCHESTRATOR_MAX_BACKOFF_MS (default 300000)
 *   ORCHESTRATOR_STALL_MS      (default 1800000)
 *   ORCHESTRATOR_PIPELINE_NAME (default: runner-side built-in)
 *   ORCHESTRATOR_LONG_POLL_MS  (default 25000) — events long-poll timeout
 *   ORCHESTRATOR_LOG_FORMAT    (text | json,  default text)
 *   ORCHESTRATOR_LOG_LEVEL     (debug | info | warn | error, default info)
 */

import { createConsoleLogger } from '../logger.js';
import { buildStandalone, type StandaloneConfig } from '../standalone.js';

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`[orchestrator] Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

const log = createConsoleLogger({
  format: process.env.ORCHESTRATOR_LOG_FORMAT === 'json' ? 'json' : 'text',
  level: (process.env.ORCHESTRATOR_LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
});

const config: StandaloneConfig = {
  serverUrl: requireEnv('FUNNY_SERVER_URL'),
  authSecret: requireEnv('ORCHESTRATOR_AUTH_SECRET'),
  pipelineName: process.env.ORCHESTRATOR_PIPELINE_NAME,
  longPollTimeoutMs: envInt('ORCHESTRATOR_LONG_POLL_MS', 25_000),
  pollIntervalMs: envInt('ORCHESTRATOR_POLL_MS', 5_000),
  reconcileIntervalMs: envInt('ORCHESTRATOR_RECONCILE_MS', 30_000),
  maxConcurrentGlobal: envInt('ORCHESTRATOR_MAX_GLOBAL', 16),
  maxConcurrentPerUser: envInt('ORCHESTRATOR_MAX_PER_USER', 4),
  maxRetryBackoffMs: envInt('ORCHESTRATOR_MAX_BACKOFF_MS', 300_000),
  stallTimeoutMs: envInt('ORCHESTRATOR_STALL_MS', 1_800_000),
  enabled: true,
};

const instance = buildStandalone(config, log);
instance.start();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('Received signal — shutting down', { namespace: 'bin', signal });
  try {
    await instance.stop();
    process.exit(0);
  } catch (err) {
    log.error('Shutdown failed', {
      namespace: 'bin',
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
