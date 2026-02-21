/**
 * Bun server bootstrap for the Pipeline Service.
 */

import { app, runner, integrator, adapterManager, director } from './index.js';
import { startHatchetWorker } from './hatchet/worker.js';

const port = parseInt(process.env.PORT ?? '3002', 10);

console.log(`[pipeline] Starting on port ${port}...`);

// Start Hatchet worker (no-op if HATCHET_CLIENT_TOKEN not set)
startHatchetWorker().catch((err) => {
  console.error('[hatchet] Worker failed to start:', err.message);
});

// ── Graceful shutdown ────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // prevent double-shutdown
  shuttingDown = true;
  console.log(`[pipeline] Shutting down (${signal})...`);
  director.stopSchedule();
  adapterManager.stop();
  await Promise.allSettled([runner.stopAll(), integrator.stopAll()]);
  console.log('[pipeline] Shutdown complete');
  process.exit(0);
}

// Unix signals (also work for Ctrl+C on Windows via Bun)
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default {
  port,
  fetch: app.fetch,
};
