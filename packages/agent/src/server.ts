/**
 * Bun server bootstrap for the Agent Service.
 */

import { app, watchdog } from './index.js';

const port = parseInt(process.env.PORT ?? '3002', 10);

console.log(`[agent] Starting on port ${port}...`);

// ── Graceful shutdown ────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[agent] Shutting down (${signal})...`);
  watchdog.stop();
  console.log('[agent] Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default {
  port,
  fetch: app.fetch,
};
