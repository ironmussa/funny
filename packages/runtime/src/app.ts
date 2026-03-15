/**
 * Runtime Hono application factory.
 *
 * Exports `createRuntimeApp()` which builds the Hono app with all routes
 * and middleware, without starting Bun.serve(). The runtime always connects
 * to a central server as a remote runner; user identity is received via
 * X-Forwarded-User headers or validated against the central server.
 */

import { existsSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

import {
  getStatusSummary,
  deriveGitSyncState,
  getNativeGit,
  WORKTREE_DIR_NAME,
} from '@funny/core/git';
import {
  getProviderModels,
  getProviderModelsWithLabels,
  PROVIDER_LABELS,
  getDefaultModel,
} from '@funny/shared/models';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';

import { log } from './lib/logger.js';
import { authMiddleware, forwardedAuthMiddleware } from './middleware/auth.js';
import { handleError } from './middleware/error-handler.js';
import { rateLimit } from './middleware/rate-limit.js';
import { tracingMiddleware } from './middleware/tracing.js';
import { automationRoutes } from './routes/automations.js';
import browseRoutes from './routes/browse.js';
import filesRoutes from './routes/files.js';
import { gitRoutes, invalidateGitStatusCacheByProject } from './routes/git.js';
import { githubRoutes } from './routes/github.js';
import { ingestRoutes } from './routes/ingest.js';
import mcpRoutes from './routes/mcp.js';
import { memoryRoutes } from './routes/memory.js';
import pluginRoutes from './routes/plugins.js';
import { projectRoutes } from './routes/projects.js';
import skillsRoutes from './routes/skills.js';
import { testRoutes } from './routes/tests.js';
import { threadRoutes } from './routes/threads.js';
import { worktreeRoutes } from './routes/worktrees.js';
import { startAgent } from './services/agent-runner.js';
import { registerAllHandlers } from './services/handlers/handler-registry.js';
import type { HandlerServiceContext } from './services/handlers/types.js';
import * as ptyManager from './services/pty-manager.js';
import type { RuntimeServiceProvider } from './services/service-provider.js';
import { getServices, setServices } from './services/service-registry.js';
import * as tm from './services/thread-manager.js';
import { handleTranscribeWs } from './services/transcribe-stream.js';
import { wsBroker } from './services/ws-broker.js';
import { resetBinaryCache } from './utils/claude-binary.js';
import {
  getAvailableProviders,
  resetProviderCache,
  logProviderStatus,
} from './utils/provider-detection.js';

// Resolve client dist directory (works both in dev and when installed via npm)
const clientDistDir = resolve(import.meta.dir, '..', '..', 'client', 'dist');

export interface RuntimeAppOptions {
  /** Client dev server port for CORS (default: 5173) */
  clientPort?: number;
  /** Custom CORS origin (comma-separated) */
  corsOrigin?: string;
  /**
   * Pre-existing database connection to share.
   * Required for legacy subsystems (pty-manager, runner-manager, email)
   * that still use direct DB access. Will be removed once those are migrated.
   */
  dbConnection?: import('@funny/shared/db/connection').DatabaseConnection;
  /** Skip auth setup (if server handles auth) */
  skipAuthSetup?: boolean;
  /** Skip static file serving */
  skipStaticServing?: boolean;
  /**
   * Injected service provider for all data access.
   * When omitted (runner mode), a stateless provider is created
   * that proxies to the server via WebSocket.
   */
  services?: RuntimeServiceProvider;
}

export interface RuntimeApp {
  /** The Hono app instance */
  app: Hono;
  /** Initialize DB, run migrations, set up auth, register handlers. */
  init(): Promise<void>;
  /** WebSocket handlers for Bun.serve() */
  websocket: {
    open(ws: any): void;
    close(ws: any): void;
    message(ws: any, msg: any): Promise<void>;
  };
  /** Authenticate and upgrade a WebSocket request. Returns upgrade data or null. */
  authenticateWs(
    req: Request,
  ): Promise<{ userId: string; organizationId: string | null; isTranscribe?: boolean } | null>;
  /** Graceful shutdown — kills child processes, PTY sessions, closes DB. */
  shutdown(): Promise<void>;
}

/**
 * Create the runtime Hono application with all routes mounted.
 * Does NOT start a server — caller is responsible for that.
 */
export async function createRuntimeApp(options: RuntimeAppOptions): Promise<RuntimeApp> {
  const clientPort = options.clientPort ?? (Number(process.env.CLIENT_PORT) || 5173);
  const corsOrigin = options.corsOrigin ?? process.env.CORS_ORIGIN;

  const app = new Hono();

  // Global error handler
  app.onError(handleError);

  // Middleware
  app.use('*', honoLogger());
  app.use('*', secureHeaders());
  app.use(
    '*',
    cors({
      origin: corsOrigin
        ? corsOrigin.split(',').map((o) => o.trim())
        : (origin: string) => {
            const allowed = [
              `http://localhost:${clientPort}`,
              `http://127.0.0.1:${clientPort}`,
              'tauri://localhost',
              'https://tauri.localhost',
            ];
            if (allowed.includes(origin)) return origin;
            if (origin.startsWith('chrome-extension://')) return origin;
            return undefined;
          },
      credentials: true,
    }),
  );
  app.use('/api/*', rateLimit({ windowMs: 60_000, max: 5000 }));
  app.use('/api/*', tracingMiddleware);
  app.route('/api/ingest', ingestRoutes);

  // Auth middleware: forwarded (server handles auth) or standalone (runtime handles auth)
  app.use('/api/*', options.skipAuthSetup ? forwardedAuthMiddleware : authMiddleware);

  // Health check
  app.get('/api/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Available shells endpoint
  app.get('/api/system/shells', (c) => {
    const { detectShells } =
      require('./services/shell-detector.js') as typeof import('./services/shell-detector.js');
    return c.json({ shells: detectShells() });
  });

  // Setup status endpoint
  app.get('/api/setup/status', async (c) => {
    resetProviderCache();
    resetBinaryCache();
    const providers = await getAvailableProviders();

    const providerInfo: Record<string, any> = {};
    for (const [name, info] of providers) {
      providerInfo[name] = {
        available: info.available,
        sdkAvailable: info.sdkAvailable,
        cliAvailable: info.cliAvailable,
        cliPath: info.cliPath ?? null,
        cliVersion: info.cliVersion ?? null,
        error: info.error ?? null,
        label: PROVIDER_LABELS[name] ?? name,
        defaultModel: info.available ? getDefaultModel(name as any) : null,
        models: info.available ? getProviderModels(name as any) : [],
        modelsWithLabels: info.available ? getProviderModelsWithLabels(name as any) : [],
      };
    }

    const claude = providers.get('claude');
    return c.json({
      providers: providerInfo,
      claudeCli: {
        available: claude?.cliAvailable ?? false,
        path: claude?.cliPath ?? null,
        error: !claude?.cliAvailable ? (claude?.error ?? 'Not available') : null,
        version: claude?.cliVersion ?? null,
      },
      agentSdk: {
        available: claude?.sdkAvailable ?? false,
      },
    });
  });

  // Bootstrap endpoint (public — returns minimal info for client init)
  app.get('/api/bootstrap', (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    c.header('Pragma', 'no-cache');
    return c.json({});
  });

  // Mount routes — only runner-specific operations
  // Server-only routes (analytics, pipelines, profile, team-projects, team-settings)
  // are handled by the server package directly.
  app.route('/api/projects', projectRoutes);
  app.route('/api/threads', threadRoutes);
  app.route('/api/git', gitRoutes);
  app.route('/api/browse', browseRoutes);
  app.route('/api/files', filesRoutes);
  app.route('/api/mcp', mcpRoutes);
  app.route('/api/skills', skillsRoutes);
  app.route('/api/plugins', pluginRoutes);
  app.route('/api/worktrees', worktreeRoutes);
  app.route('/api/github', githubRoutes);
  app.route('/api/tests', testRoutes);
  app.route('/api/automations', automationRoutes);
  app.route('/api/projects', memoryRoutes);

  // Serve static files from client build
  if (!options.skipStaticServing && existsSync(clientDistDir)) {
    app.use('/*', serveStatic({ root: clientDistDir }));
    app.get('*', async (c) => {
      return c.html(await Bun.file(join(clientDistDir, 'index.html')).text());
    });
    log.info('Serving static files', { namespace: 'server', dir: clientDistDir });
  }

  // ── init() — service provider, handlers, startup tasks ──────────
  async function init() {
    // Wire up the service provider — injected by the server, or auto-created for runner mode.
    if (options.services) {
      setServices(options.services);
      log.info('Service provider injected by server', { namespace: 'server' });
    } else {
      const { createRunnerServiceProvider } = await import('./services/runner-service-provider.js');
      setServices(createRunnerServiceProvider());
      log.info('Stateless runner service provider created', { namespace: 'server' });
    }

    // Share the DB connection for legacy subsystems that still use direct access
    // (pty-manager, runner-manager, email). Will be removed once those are migrated.
    if (options.dbConnection) {
      const { setConnection } = await import('./db/index.js');
      setConnection(options.dbConnection);
    }

    log.info('Runner mode — skipping auth and scheduler', { namespace: 'server' });

    // Register handler registry (needed in both modes for tunnel:request handling)
    const handlerCtx: HandlerServiceContext = {
      getThread: tm.getThread,
      updateThread: tm.updateThread,
      insertComment: tm.insertComment,
      getProject: getServices().projects.getProject,
      emitToUser: (userId, event) => wsBroker.emitToUser(userId, event),
      broadcast: (event) => wsBroker.emit(event),
      startAgent,
      getGitStatusSummary: getStatusSummary,
      deriveGitSyncState,
      invalidateGitStatusCache: invalidateGitStatusCacheByProject,
      saveThreadEvent: getServices().threadEvents.saveThreadEvent,
      dequeueMessage: getServices().messageQueue.dequeue,
      queueCount: getServices().messageQueue.queueCount,
      peekMessage: getServices().messageQueue.peek,
      log: (msg) => log.info(msg, { namespace: 'handler' }),
    };
    registerAllHandlers(handlerCtx);

    await logProviderStatus();

    // Reattach PTY sessions
    ptyManager.reattachSessions();

    // Eagerly load native git
    getNativeGit();

    // Connect to central server
    if (!process.env.RUNNER_AUTH_SECRET) {
      log.error('RUNNER_AUTH_SECRET is required when TEAM_SERVER_URL is set.', {
        namespace: 'server',
      });
      process.exit(1);
    }
    const { initTeamMode, setBrowserWSHandler, setLocalApp } =
      await import('./services/team-client.js');
    await initTeamMode(process.env.TEAM_SERVER_URL!);
    // Register the local app so tunnel:request messages can be forwarded to it
    setLocalApp(app);

    setBrowserWSHandler(async (userId, data, respond) => {
      const parsed = data as { type: string; data: any };
      if (!parsed?.type) return;
      handlePtyMessage(parsed.type, parsed.data, userId, (msg) => respond(msg));
    });
  }

  // ── WebSocket authentication ───────────────────────────────────
  async function authenticateWs(
    req: Request,
  ): Promise<{ userId: string; organizationId: string | null; isTranscribe?: boolean } | null> {
    const url = new URL(req.url);

    // Transcription WebSocket
    if (url.pathname === '/ws/transcribe') {
      const { auth } = await import('./lib/auth.js');
      const session = await auth.api.getSession({ headers: req.headers });
      if (!session) return null;
      return { userId: session.user.id, organizationId: null, isTranscribe: true };
    }

    // Browser WebSocket
    if (url.pathname === '/ws') {
      // Try central server session validation first (team mode)
      const teamServerUrl = process.env.TEAM_SERVER_URL;
      const cookie = req.headers.get('Cookie');
      if (teamServerUrl && cookie) {
        try {
          const forwardCookie = cookie.replace(/\bbetter-auth\./g, '__Secure-better-auth.');
          const res = await fetch(`${teamServerUrl}/api/auth/get-session`, {
            headers: { Cookie: forwardCookie },
          });
          if (res.ok) {
            const data = (await res.json()) as any;
            if (data?.user?.id) {
              return {
                userId: data.user.id,
                organizationId: data.session?.activeOrganizationId ?? null,
              };
            }
          }
        } catch {
          // Fall through to local Better Auth
        }
      }

      // Validate with local Better Auth
      const { auth } = await import('./lib/auth.js');
      const session = await auth.api.getSession({ headers: req.headers });
      if (!session) return null;
      return {
        userId: session.user.id,
        organizationId: (session.session as any).activeOrganizationId ?? null,
      };
    }

    return null;
  }

  // ── WebSocket handlers ─────────────────────────────────────────
  const websocket = {
    open(ws: any) {
      if (ws.data?.isTranscribe) {
        handleTranscribeWs(ws, ws.data.userId);
        return;
      }
      const userId = ws.data?.userId;
      if (!userId) return;
      const organizationId = ws.data?.organizationId ?? null;
      wsBroker.addClient(ws, userId, organizationId);
    },
    close(ws: any) {
      if (ws.data?.isTranscribe) {
        const assemblyWs = ws.data?.assemblyWs;
        if (assemblyWs && assemblyWs.readyState === 1) {
          try {
            assemblyWs.send(JSON.stringify({ type: 'Terminate' }));
          } catch {}
          assemblyWs.close();
        }
        return;
      }
      wsBroker.removeClient(ws);
    },
    async message(ws: any, msg: any) {
      try {
        if (ws.data?.isTranscribe) {
          const assemblyWs = ws.data?.assemblyWs;
          if (!assemblyWs || assemblyWs.readyState !== 1) return;
          if (typeof msg !== 'string') assemblyWs.send(msg);
          return;
        }

        const parsed = JSON.parse(msg.toString());
        const { type, data } = parsed;
        const userId = ws.data?.userId;
        if (!userId) return;

        handlePtyMessage(type, data, userId, (msg) => {
          try {
            ws.send(JSON.stringify(msg));
          } catch {}
        });
      } catch (err) {
        log.error('Error handling message', { namespace: 'ws', error: err });
      }
    },
  };

  async function shutdown(): Promise<void> {
    const { shutdownManager } = await import('./services/shutdown-manager.js');
    await shutdownManager.run('hard');
  }

  return { app, init, websocket, authenticateWs, shutdown };
}

// ── Shared PTY message handler ─────────────────────────────────
function handlePtyMessage(type: string, data: any, userId: string, send: (msg: any) => void) {
  switch (type) {
    case 'pty:spawn': {
      // Validate cwd against user projects
      getServices()
        .projects.listProjects(userId)
        .then((userProjects) => {
          const resolvedCwd = resolve(data.cwd);
          const isAllowed = userProjects.some((p: any) => {
            const projectPath = resolve(p.path);
            if (resolvedCwd.startsWith(projectPath)) return true;
            const worktreeBase = resolve(
              dirname(projectPath),
              WORKTREE_DIR_NAME,
              basename(projectPath),
            );
            return resolvedCwd.startsWith(worktreeBase);
          });
          if (!isAllowed) {
            log.warn(`PTY spawn denied: cwd not in user's projects`, {
              namespace: 'ws',
              cwd: data.cwd,
              userId,
            });
            send({
              type: 'pty:error',
              data: {
                ptyId: data.id,
                error: 'Access denied: directory not in a registered project',
              },
            });
            return;
          }
          ptyManager.spawnPty(
            data.id,
            data.cwd,
            data.cols,
            data.rows,
            userId,
            data.shell,
            data.projectId,
            data.label,
          );
        });
      break;
    }
    case 'pty:write':
      ptyManager.writePty(data.id, data.data);
      break;
    case 'pty:resize':
      ptyManager.resizePty(data.id, data.cols, data.rows);
      break;
    case 'pty:kill':
      ptyManager.killPty(data.id);
      break;
    case 'pty:restore': {
      const captured = ptyManager.capturePane(data.id);
      if (captured) {
        send({
          type: 'pty:data',
          threadId: '',
          data: { ptyId: data.id, data: captured },
        });
      }
      break;
    }
    case 'pty:list': {
      const sessions = ptyManager.listActiveSessions(userId);
      send({
        type: 'pty:sessions',
        threadId: '',
        data: {
          sessions: sessions.map((s) => ({
            ptyId: s.ptyId,
            cwd: s.cwd,
            projectId: s.projectId,
            label: s.label,
            shell: s.shell,
          })),
        },
      });
      break;
    }
    default:
      log.warn(`Unknown message type: ${type}`, { namespace: 'ws' });
  }
}
