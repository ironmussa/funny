/**
 * Runtime Hono application factory.
 *
 * Exports `createRuntimeApp()` which builds the Hono app with all routes
 * and middleware, without starting Bun.serve(). The runtime is always a
 * standalone remote runner that connects to the central server via
 * TEAM_SERVER_URL. It has no database — all data is proxied to the server
 * via the WebSocket data channel.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';

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
import { authMiddleware } from './middleware/auth.js';
import { handleError } from './middleware/error-handler.js';
import { defaultRateLimit, mutationRateLimit } from './middleware/rate-limit.js';
import { tracingMiddleware } from './middleware/tracing.js';
import { arcRoutes, arcProjectRoutes } from './routes/arcs.js';
import { automationRoutes } from './routes/automations.js';
import browseRoutes from './routes/browse.js';
import filesRoutes from './routes/files.js';
import { gitRoutes, invalidateGitStatusCacheByProject } from './routes/git.js';
import { githubRoutes } from './routes/github.js';
import { ingestRoutes } from './routes/ingest.js';
import mcpRoutes from './routes/mcp.js';
import pluginRoutes from './routes/plugins.js';
import { projectRoutes } from './routes/projects.js';
import skillsRoutes from './routes/skills.js';
import { testRoutes } from './routes/tests.js';
import { threadRoutes } from './routes/threads.js';
import { worktreeRoutes } from './routes/worktrees.js';
import { startAgent } from './services/agent-runner.js';
import { rehydrateWatchers } from './services/git-watcher-service.js';
import { registerAllHandlers } from './services/handlers/handler-registry.js';
import type { HandlerServiceContext } from './services/handlers/types.js';
import * as ptyManager from './services/pty-manager.js';
import { getServices, setServices } from './services/service-registry.js';
import * as tm from './services/thread-manager.js';
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
  /** Skip static file serving */
  skipStaticServing?: boolean;
}

export interface RuntimeApp {
  /** The Hono app instance */
  app: Hono;
  /** Initialize DB, run migrations, set up auth, register handlers. */
  init(): Promise<void>;
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
            // Reject unknown origins explicitly (returning undefined may be truthy in some middleware)
            return false as unknown as string;
          },
      credentials: true,
    }),
  );
  app.use('/api/*', defaultRateLimit());
  app.use('/api/*', tracingMiddleware);
  app.route('/api/ingest', ingestRoutes);

  // Auth middleware: validates X-Runner-Auth from server proxy, or direct sessions
  app.use('/api/*', authMiddleware);

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

    // Detect native git status
    const nativeGitLoaded = getNativeGit() !== null;
    const nativeGitDisabled = process.env.FUNNY_DISABLE_NATIVE_GIT === '1';
    const nativeGitDir = resolve(import.meta.dir, '..', '..', '..', 'native-git');
    const hasCargoToml = existsSync(join(nativeGitDir, 'Cargo.toml'));

    let rustAvailable = false;
    let rustVersion: string | null = null;
    try {
      const result = spawnSync('cargo', ['--version'], { timeout: 5000 });
      if (result.status === 0 && result.stdout) {
        rustVersion = result.stdout.toString().trim();
        rustAvailable = true;
      }
    } catch {
      // cargo not available
    }

    const platform = `${process.platform}-${process.arch}`;

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
      nativeGit: {
        loaded: nativeGitLoaded,
        disabled: nativeGitDisabled,
        rustAvailable,
        rustVersion,
        platform,
        canBuild: rustAvailable && hasCargoToml,
      },
    });
  });

  // Native git build endpoint
  let nativeGitBuildInProgress = false;
  app.post('/api/system/build-native-git', async (c) => {
    const userId = c.get('userId') as string;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    if (nativeGitBuildInProgress) {
      return c.json({ error: 'Build already in progress' }, 409);
    }

    const nativeGitDir = resolve(import.meta.dir, '..', '..', '..', 'native-git');
    if (!existsSync(join(nativeGitDir, 'Cargo.toml'))) {
      return c.json({ error: 'native-git package not found' }, 404);
    }

    // Check Rust toolchain
    try {
      const check = spawnSync('cargo', ['--version'], { timeout: 5000 });
      if (check.status !== 0) {
        return c.json({ error: 'Rust toolchain not available' }, 400);
      }
    } catch {
      return c.json({ error: 'Rust toolchain not available' }, 400);
    }

    nativeGitBuildInProgress = true;

    const emitBuild = (type: string, data: unknown) => {
      wsBroker.emitToUser(userId, { type, threadId: '', data } as any);
    };

    emitBuild('native-git:build_status', { status: 'building' });

    // Spawn the build process
    const proc = Bun.spawn(['napi', 'build', '--platform', '--release'], {
      cwd: nativeGitDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    // Stream stdout/stderr
    const streamReader = async (stream: ReadableStream<Uint8Array>, channel: string) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          emitBuild('native-git:build_output', {
            text: decoder.decode(value, { stream: true }),
            channel,
          });
        }
      } catch {
        // stream closed
      }
    };

    void streamReader(proc.stdout as ReadableStream<Uint8Array>, 'stdout');
    void streamReader(proc.stderr as ReadableStream<Uint8Array>, 'stderr');

    // Handle exit
    proc.exited.then((exitCode) => {
      nativeGitBuildInProgress = false;
      emitBuild('native-git:build_status', {
        status: exitCode === 0 ? 'completed' : 'failed',
        exitCode,
      });
    });

    return c.json({ status: 'started' });
  });

  // Bootstrap endpoint (public — returns minimal info for client init)
  app.get('/api/bootstrap', (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    c.header('Pragma', 'no-cache');
    return c.json({ mode: 'local' });
  });

  // Mount routes — only runner-specific operations
  // Server-only routes (analytics, pipelines, profile, team-projects, team-settings)
  // are handled by the server package directly.

  // Tiered rate limits: stricter limits for mutation-heavy endpoints
  app.use('/api/threads/*', mutationRateLimit());
  app.use('/api/git/*', mutationRateLimit());
  app.use('/api/worktrees/*', mutationRateLimit());

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
  app.route('/api/arcs', arcRoutes);
  app.route('/api/projects', arcProjectRoutes);

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
    // Create the stateless runner service provider — proxies all data to the server via WebSocket.
    const { createRunnerServiceProvider } = await import('./services/runner-service-provider.js');
    setServices(createRunnerServiceProvider());
    log.info('Runner service provider created', { namespace: 'server' });

    // Register handler registry (needed in both modes for tunnel:request handling)
    const handlerCtx: HandlerServiceContext = {
      getThread: tm.getThread,
      updateThread: tm.updateThread,
      insertComment: tm.insertComment,
      getProject: getServices().projects.getProject,
      emitToUser: (userId, event) => wsBroker.emitToUser(userId, event),
      broadcast: (event) => wsBroker.emit(event),
      startAgent: (
        threadId,
        prompt,
        cwd,
        model,
        permissionMode,
        images,
        disallowedTools,
        allowedTools,
        provider,
        skipMessageInsert,
      ) =>
        startAgent(
          threadId,
          prompt,
          cwd,
          model,
          permissionMode,
          images,
          disallowedTools,
          allowedTools,
          provider,
          undefined,
          skipMessageInsert,
        ),
      getGitStatusSummary: getStatusSummary,
      deriveGitSyncState,
      invalidateGitStatusCache: invalidateGitStatusCacheByProject,
      saveThreadEvent: getServices().threadEvents.saveThreadEvent,
      dequeueMessage: getServices().messageQueue.dequeue,
      enqueueMessage: getServices().messageQueue.enqueue,
      queueCount: getServices().messageQueue.queueCount,
      peekMessage: getServices().messageQueue.peek,
      log: (msg) => log.info(msg, { namespace: 'handler' }),
    };
    registerAllHandlers(handlerCtx);

    await logProviderStatus();

    // Reattach PTY sessions
    await ptyManager.reattachSessions();

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
    // Register the local app and browser WS handler BEFORE connecting so that
    // any messages the server pushes immediately after the socket connects
    // (e.g. the pty:list sync on runner reconnect) are not dropped with a
    // "No browser WS handler registered" warning.
    setLocalApp(app);
    setBrowserWSHandler(async (userId, data, respond) => {
      const parsed = data as { type: string; data: any };
      if (!parsed?.type) return;
      handlePtyMessage(parsed.type, parsed.data, userId, (msg) => respond(msg));
    });
    await initTeamMode(process.env.TEAM_SERVER_URL!);

    // Rehydrate git file watchers for existing threads
    rehydrateWatchers().catch((err) => {
      log.error('Failed to rehydrate git watchers', {
        namespace: 'server',
        error: (err as Error).message,
      });
    });

    // Auto-resume threads that were running when the runtime crashed
    autoResumeStaleThreads().catch((err) => {
      log.error('Failed to auto-resume stale threads', {
        namespace: 'server',
        error: (err as Error).message,
      });
    });
  }

  /**
   * On startup, find threads that were running when the runtime crashed,
   * mark them as interrupted, and automatically resume each one.
   */
  async function autoResumeStaleThreads(): Promise<void> {
    const { remoteMarkAndListStaleThreads } = await import('./services/team-client.js');
    const staleThreads = await remoteMarkAndListStaleThreads();
    if (staleThreads.length === 0) return;

    log.info(`Auto-resuming ${staleThreads.length} interrupted thread(s)`, {
      namespace: 'server',
      count: staleThreads.length,
      threadIds: staleThreads.map((t: any) => t.id),
    });

    for (const thread of staleThreads) {
      try {
        // Resolve the working directory: worktree path takes priority, then project path
        let cwd = thread.worktreePath;
        if (!cwd) {
          const pathResult = await getServices().projects.resolveProjectPath(
            thread.projectId,
            thread.userId,
          );
          if (pathResult.isErr()) {
            log.warn('Cannot auto-resume thread — failed to resolve project path', {
              namespace: 'server',
              threadId: thread.id,
              error: pathResult.error.message,
            });
            continue;
          }
          cwd = pathResult.value;
        }

        await startAgent(
          thread.id,
          'continue',
          cwd,
          thread.model,
          thread.permissionMode,
          undefined, // images
          undefined, // disallowedTools
          undefined, // allowedTools
          thread.provider,
        );

        log.info('Auto-resumed thread', {
          namespace: 'server',
          threadId: thread.id,
          model: thread.model,
          provider: thread.provider,
        });
      } catch (err) {
        log.error('Failed to auto-resume thread', {
          namespace: 'server',
          threadId: thread.id,
          error: (err as Error).message,
        });
      }
    }
  }

  async function shutdown(): Promise<void> {
    const { shutdownManager } = await import('./services/shutdown-manager.js');
    await shutdownManager.run('hard');
  }

  return { app, init, shutdown };
}

// ── Shared PTY message handler ─────────────────────────────────
function handlePtyMessage(type: string, data: any, userId: string, send: (msg: any) => void) {
  switch (type) {
    case 'pty:spawn': {
      log.info('pty:spawn received', {
        namespace: 'ws',
        ptyId: data.id,
        projectId: data.projectId,
        userId,
      });

      const resolvedCwd = resolve(data.cwd);
      const isUnder = (target: string, scope: string) =>
        target === scope || target.startsWith(scope + sep);
      const isCwdAllowed = (userProjects: Array<{ path: string }>) =>
        userProjects.some((p) => {
          const projectPath = resolve(p.path);
          if (isUnder(resolvedCwd, projectPath)) return true;
          const worktreeBase = resolve(
            dirname(projectPath),
            WORKTREE_DIR_NAME,
            basename(projectPath),
          );
          return isUnder(resolvedCwd, worktreeBase);
        });

      const denyAccess = () => {
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
      };

      const doSpawn = () => {
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
      };

      // Fast path: validate against runner-local project cache to avoid a
      // slow (and sometimes flaky) data-channel roundtrip on every spawn.
      import('./services/team-client.js')
        .then(({ getLocalProjects }) => {
          const cached = getLocalProjects();
          if (cached) {
            if (!isCwdAllowed(cached)) return denyAccess();
            return doSpawn();
          }

          // Cache not warm yet — fall back to server lookup.
          return getServices()
            .projects.listProjects(userId)
            .then((userProjects) => {
              if (!isCwdAllowed(userProjects)) return denyAccess();
              doSpawn();
            });
        })
        .catch((err) => {
          log.error('PTY spawn failed: project validation error', {
            namespace: 'ws',
            error: err,
            ptyId: data.id,
            userId,
          });
          send({
            type: 'pty:error',
            data: {
              ptyId: data.id,
              error: 'Failed to validate project access',
            },
          });
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
    case 'pty:signal': {
      const VALID_SIGNALS: Record<string, number> = {
        SIGINT: 2,
        SIGTERM: 15,
        SIGKILL: 9,
      };
      const sigNum = VALID_SIGNALS[data.signal];
      if (sigNum !== undefined) {
        ptyManager.signalPty(data.id, sigNum);
      } else {
        log.warn('Invalid signal requested', {
          namespace: 'ws',
          signal: data.signal,
          ptyId: data.id,
        });
      }
      break;
    }
    case 'pty:restore': {
      ptyManager.capturePaneAsync(data.id).then((captured) => {
        // Always respond — even with empty string — so the client exits loading state.
        // If captured is null the session may be freshly spawned with no output yet.
        send({
          type: 'pty:data',
          threadId: '',
          data: { ptyId: data.id, data: captured ?? '' },
        });
      });
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
