/**
 * Bun host for the central server: validates the shared secrets, initializes
 * the database and auth, composes the HTTP app (`../../app.ts`), starts the
 * realtime and runner transports and background jobs, listens with
 * `Bun.serve`, and owns process lifecycle (signals, shutdown, crash handlers).
 */

import { scheduleRepeating } from '@funny/shared/async';

import { createServerApp } from '../../app.js';
import { resolveCorsOrigins } from '../../lib/cors-origins.js';
import { ensureDataDir } from '../../lib/data-dir.js';
import { attachFileLogTransport, log } from '../../lib/logger.js';
import { mountBunAssets } from './assets.js';

export interface BunHostOptions {
  /** Built client bundle (`packages/client/dist`), served when it exists. */
  clientDistDir: string;
}

export async function startBunServer(opts: BunHostOptions) {
  // The data dir and the log file are host concerns: nothing creates them on import.
  ensureDataDir();
  attachFileLogTransport();

  // Ensure a RUNNER_AUTH_SECRET exists
  if (!process.env.RUNNER_AUTH_SECRET) {
    log.error('RUNNER_AUTH_SECRET is required. Set it in your .env file.', {
      namespace: 'server',
    });
    process.exit(1);
  }

  // Security CR-1: the three shared secrets cross independent trust boundaries
  // (runner↔server, scheduler↔server, external webhook→runner). Reusing one
  // value across them means compromise of any single path leaks all three.
  // Refuse to boot when any two are set to the same value.
  {
    const { findDuplicateSecretPairs, findWeakSecrets, MIN_SECRET_LENGTH } =
      await import('../../lib/secret-check.js');
    const presentSecrets = {
      RUNNER_AUTH_SECRET: process.env.RUNNER_AUTH_SECRET,
      INGEST_WEBHOOK_SECRET: process.env.INGEST_WEBHOOK_SECRET,
      SCHEDULER_AUTH_SECRET: process.env.SCHEDULER_AUTH_SECRET,
    };
    const duplicates = findDuplicateSecretPairs(presentSecrets);
    if (duplicates.length > 0) {
      log.error(
        'Shared secrets must be distinct. Generate a fresh value for each with `openssl rand -hex 32`.',
        {
          namespace: 'server',
          duplicates: duplicates.map(([a, b]) => `${a} === ${b}`),
        },
      );
      process.exit(1);
    }

    // Security: RUNNER_AUTH_SECRET is the HMAC key for forwarded-identity
    // signing — a weak value lets a caller forge any user's identity against a
    // runner. Refuse to boot on a too-short shared secret.
    const weak = findWeakSecrets(presentSecrets);
    if (weak.length > 0) {
      log.error(
        `Shared secrets must be at least ${MIN_SECRET_LENGTH} characters. Generate one with \`openssl rand -hex 32\`.`,
        { namespace: 'server', weak },
      );
      process.exit(1);
    }
  }

  // ── Always initialize server DB and auth ────────────────
  const { initDatabase } = await import('../../db/index.js');
  const { autoMigrate } = await import('../../db/migrate.js');
  const { initBetterAuth, auth } = await import('../../lib/auth.js');

  const dbResult = await initDatabase();
  if (dbResult.isErr()) {
    log.error(dbResult.error, { namespace: 'db' });
    process.exit(1);
  }
  await autoMigrate();
  await initBetterAuth();
  // Auth instance — used by middleware and route handlers. `any` because the
  // runtime and server auth instances have slightly different types.
  const authInstance: any = auth;

  const { dbDialect } = await import('../../db/index.js');
  log.info(`Server initialized — DB mode: ${dbDialect}`, { namespace: 'server' });

  // On restart, purge all runners and their project assignments.
  // No runner has an active WebSocket connection at this point, so all
  // state is stale. Runners will re-register and re-assign projects on connect.
  const { purgeAllRunners, purgeStaleRunners } = await import('../../services/runner-manager.js');
  await purgeAllRunners();
  await purgeStaleRunners();

  // ── App ─────────────────────────────────────────────────

  const corsOrigins = resolveCorsOrigins();
  const app = await createServerApp({
    authInstance,
    corsOrigins,
    mountAssets: (a) => mountBunAssets(a, opts.clientDistDir),
  });

  // ── Server ──────────────────────────────────────────────

  const PORT = parseInt(process.env.PORT || '3001', 10);
  // Security CR-7: default to loopback. The auto-generated admin credentials
  // (`~/.funny/admin-password.txt`) are written *after* the server starts
  // listening; binding all interfaces by default opens a window where the
  // stock admin/admin race is reachable from the LAN/internet. Operators who
  // genuinely want remote exposure set HOST=0.0.0.0 explicitly.
  const { resolveHost } = await import('../../lib/host-default.js');
  const HOST = resolveHost(process.env.HOST);

  // Initialize Socket.IO server with Bun-native engine
  const { createSocketIOServer, closeSocketIO } = await import('../../services/socketio.js');
  const { engine: socketEngine, browserEvents } = createSocketIOServer(authInstance, corsOrigins);
  const { startRunnerServerComposition } =
    await import('../../services/runner-server-composition.js');
  const runnerTransport = await startRunnerServerComposition(browserEvents);
  const browserRunnerManager = await import('../../services/runner-manager.js');
  const browserProjectRepository = await import('../../services/project-repository.js');
  const { setupBrowserNamespace } = await import('../../services/socketio/browser-namespace.js');
  setupBrowserNamespace({
    presence: runnerTransport?.presence,
    requests: runnerTransport?.requests,
    terminals: runnerTransport?.terminals,
    // Runner selection + certification default to `services/runner-access`
    // (runner-request-isolation); the handlers never pick a runner themselves.
    getRunnerUserId: browserRunnerManager.getRunnerUserId,
    getProjectOwnerId: async (projectId) =>
      (await browserProjectRepository.getProject(projectId))?.userId ?? null,
  });

  // Scheduler runs as a separate process (`@funny/thread-scheduler` binary)
  // that talks to the server via /api/scheduler/system/*. The server no
  // longer hosts the brain in-process — see README "Running the scheduler
  // standalone" for the migration path.

  // Automations: the server owns the cron and dispatches each run to the
  // automation owner's runner (services/automation-scheduler.ts).
  const automationScheduler = await import('../../services/automation-scheduler.js');
  if (runnerTransport) {
    await automationScheduler.startAutomationScheduler({
      ports: { requests: runnerTransport.requests, presence: runnerTransport.presence },
    });
  }

  // Thread sandboxes: stop idle ones, wake stopped ones on demand.
  const sandboxLifecycle = await import('../../services/thread-sandboxes/sandbox-lifecycle.js');
  if (runnerTransport) {
    sandboxLifecycle.startSandboxLifecycle({ presence: runnerTransport.presence, browserEvents });
  }

  // Runners outside the private network reach the gRPC listener through a
  // WebSocket carrier on this public origin (see services/grpc/websocket-carrier.ts).
  const {
    createRunnerGrpcWebSocketCarrier,
    carrierTargetFor,
    routeRunnerCarrier,
    withRunnerCarrier,
  } = await import('../../services/grpc/websocket-carrier.js');
  const runnerCarrier = runnerTransport
    ? createRunnerGrpcWebSocketCarrier({ target: carrierTargetFor(runnerTransport.endpoint) })
    : null;
  const socketEngineHandler = socketEngine.handler();
  const appEnv = {
    runnerRequests: runnerTransport?.requests,
    runnerPresence: runnerTransport?.presence,
    browserEvents,
  };

  // `any` WebSocket data: one server hosts Socket.IO sockets and runner carrier sockets.
  const server = Bun.serve<any>({
    // Spread Bun engine handler FIRST — provides idle/body limits; the
    // `websocket` lifecycle is shared with the runner carrier.
    ...socketEngineHandler,
    websocket: withRunnerCarrier(socketEngineHandler.websocket, runnerCarrier),
    port: PORT,
    hostname: HOST,
    reusePort: true,
    async fetch(req, server) {
      // Handle Socket.IO requests BEFORE Hono — WebSocket upgrades need
      // direct access to Bun's server.upgrade(), which returns undefined
      // (Hono always expects a Response, so it can't handle upgrades).
      const url = new URL(req.url);
      if (url.pathname.startsWith('/socket.io/')) {
        return socketEngine.handleRequest(req, server);
      }
      const carried = routeRunnerCarrier(req, server, runnerCarrier);
      if (carried !== null) return carried;
      return app.fetch(req, { ...appEnv, IP: server.requestIP(req) });
    },
  });

  log.info(`funny-server running on http://${HOST}:${PORT}`, {
    namespace: 'server',
  });

  // Native runner transport uses a dedicated HTTP/2 listener and is disabled by
  // default. The deployment ingress terminates public TLS before forwarding to
  // this listener; bearer metadata is authenticated at the transport boundary.
  // ── Runner status monitor (debug) ────────────────────────
  // Socket.IO handles heartbeats natively (pingInterval/pingTimeout),
  // so we only check periodically for DB↔connection state mismatches.
  const RUNNER_STATUS_INTERVAL_MS = 30_000;
  let runnerStatusMonitor: ReturnType<typeof scheduleRepeating> | null = null;
  let lastRunnerStateHash = '';
  const runnerStatusMonitorEnabled = process.env.FUNNY_RUNNER_STATUS_MONITOR === 'true';

  if (process.env.NODE_ENV !== 'production' && runnerStatusMonitorEnabled) {
    runnerStatusMonitor = scheduleRepeating(async () => {
      try {
        const browserEvents = await import('../../services/browser-events.js');
        const rm = await import('../../services/runner-manager.js');
        const stats = browserEvents.getRelayStats();
        const allRunners = await rm.listRunners();
        const presence = runnerTransport?.presence;

        const connectedCount = (await presence?.availableRunnerCount()) ?? 0;
        if (allRunners.length === 0 && !connectedCount) return; // nothing to report

        const runnerDetails = await Promise.all(
          allRunners.map(async (r) => ({
            id: r.runnerId.slice(0, 8),
            name: r.name,
            dbStatus: r.status,
            connected: (await presence?.isAvailable(r.runnerId)) ?? false,
            lastHb: r.lastHeartbeatAt,
            threads: r.activeThreadCount,
            projects: r.assignedProjectIds.length,
          })),
        );

        // Warn when there's a mismatch between Socket.IO connection and DB status
        const hasIssue = runnerDetails.some(
          (r) =>
            (r.dbStatus === 'online' && !r.connected) || (r.dbStatus === 'offline' && r.connected),
        );

        // Only log when state changes or there's an issue
        const stateHash = JSON.stringify(
          runnerDetails.map((r) => `${r.id}:${r.dbStatus}:${r.connected}`),
        );
        if (stateHash === lastRunnerStateHash && !hasIssue) return;
        lastRunnerStateHash = stateHash;

        const level = hasIssue ? 'warn' : 'info';
        log[level]('Runner status', {
          namespace: 'runner-monitor',
          runners: connectedCount,
          browsers: stats.browserClients,
          runnerDetails: JSON.stringify(runnerDetails),
        });
      } catch {
        // Ignore — DB may not be ready yet
      }
    }, RUNNER_STATUS_INTERVAL_MS);
  }

  // ── Graceful shutdown ────────────────────────────────────
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down…', { namespace: 'server' });

    // Stop runner status monitor
    runnerStatusMonitor?.stop();
    await runnerStatusMonitor?.done;

    // Force exit after 5 seconds if graceful shutdown hangs
    const forceExit = setTimeout(() => {
      log.warn('Force exit after timeout', { namespace: 'server' });
      process.exit(1);
    }, 5000);

    // Stop firing automations before the runner transport goes away
    automationScheduler.stopAutomationScheduler();
    // Cancelled sandbox setups destroy their machines (bounded wait, under forceExit).
    await sandboxLifecycle.stopSandboxLifecycle();

    // Close Socket.IO connections
    await closeSocketIO();

    // Stop accepting new runner gRPC streams and drain existing handlers.
    if (runnerTransport) await runnerTransport.shutdown();

    // Stop accepting new connections (don't wait for in-flight)
    server.stop();

    // Close the server DB connection
    try {
      const { closeDatabase } = await import('../../db/index.js');
      await closeDatabase();
    } catch {
      // Already closed or not initialized
    }

    clearTimeout(forceExit);
    log.info('Shutdown complete', { namespace: 'server' });
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Catch unhandled errors — keep server alive
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception — keeping server alive', {
      namespace: 'server',
      error: err?.message ?? String(err),
      stack: err?.stack,
    });
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.error('Unhandled rejection — keeping server alive', {
      namespace: 'server',
      error: msg,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  return { app, server };
}
