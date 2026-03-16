/**
 * Bun server bootstrap for the Agent Service.
 */

import {
  app,
  ciRetryWorkflow,
  reviewWorkflow,
  mergeWorkflow,
  reviewAdapter,
  ingestAdapter,
} from './index.js';

const port = parseInt(process.env.PORT ?? '3002', 10);

console.info(`[agent] Starting on port ${port}...`);

// ── Graceful shutdown ────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[agent] Shutting down (${signal})...`);
  ciRetryWorkflow.stop();
  reviewWorkflow.stop();
  mergeWorkflow.stop();
  reviewAdapter.stop();
  ingestAdapter.stop();
  console.info('[agent] Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default {
  port,
  fetch: app.fetch,
};
