/**
 * @domain subdomain: Runner ↔ Server Communication
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 *
 * Runner client — connects this runtime instance to the central server.
 * Activated when TEAM_SERVER_URL is set, which configures this runtime
 * as a runner that executes agent work on behalf of the server.
 *
 * Uses native gRPC for all runner-to-server realtime communication.
 *
 * Responsibilities:
 * - Authenticate with the central server (HTTP registration)
 * - Maintain the gRPC session for control, events, tunnel, terminal, and data
 * - Cache local projects used to authorize runner-side operations
 */

import { hostname } from 'os';
import { join } from 'path';

import {
  disableBuiltinProvider,
  enableBuiltinProvider,
  getActiveBuiltinProviders,
  getActiveProviderSpawnRefs,
  getAdvertisedProviders,
  loadProviderExtensions,
} from '@funny/core/agents';
import type { Project, WSEvent } from '@funny/shared';
import { GATEABLE_ACP_PROVIDER_IDS } from '@funny/shared/provider-manifests';

import { DATA_DIR } from '../lib/data-dir.js';
import { log } from '../lib/logger.js';
import { resolveProviderAvailability } from '../utils/provider-detection.js';
import type { RunnerGrpcWireMessage } from './grpc-runner-client.js';
import { GrpcTeamTransport, type GrpcTerminalCommand } from './grpc-team-transport.js';
import { configureRemoteDataTransport } from './remote-data-channel.js';
import {
  configureRemoteProjectAssignment,
  remoteProjectIdentityClient,
} from './remote-project-identity-client.js';
import {
  RunnerConnectionSupervisor,
  requireRunnerGrpcEndpoint,
} from './runner-connection-supervisor.js';
import { RunnerEnrollmentClient } from './runner-enrollment-client.js';
import { getServices } from './service-registry.js';

/**
 * The provider state advertised to the server on register + heartbeat: external
 * providers, the active built-in set (lean-core), and which active providers can
 * actually run (model-picker-availability). Kept together so all three stay in
 * sync on every advertisement.
 */
async function advertisedProviderState(): Promise<{
  providers: ReturnType<typeof getAdvertisedProviders>;
  activeBuiltins: string[];
  availableProviders: string[];
}> {
  return {
    providers: getAdvertisedProviders(),
    activeBuiltins: getActiveBuiltinProviders(),
    availableProviders: await resolveProviderAvailability(getActiveProviderSpawnRefs()),
  };
}
import { wsBroker } from './ws-broker.js';

export type BrowserWSHandler = (
  userId: string,
  data: unknown,
  respond: (responseData: unknown) => void,
) => void;

/** A Hono-like app that can handle fetch requests */
type FetchableApp = {
  fetch: (request: Request) => Promise<Response> | Response;
};

interface TeamClientState {
  serverUrl: string;
  runnerId: string | null;
  runnerToken: string | null;
  enrollment: RunnerEnrollmentClient | null;
  connection: RunnerConnectionSupervisor | null;
  unsubscribeBroker: (() => void) | null;
  browserWSHandler: BrowserWSHandler | null;
  /** Reference to the local Hono app for handling tunnel requests */
  localApp: FetchableApp | null;
}

const state: TeamClientState = {
  serverUrl: '',
  runnerId: null,
  runnerToken: null,
  enrollment: null,
  connection: null,
  unsubscribeBroker: null,
  browserWSHandler: null,
  localApp: null,
};

/** Runner team mode has no legacy transport fallback. */
export { requireRunnerGrpcEndpoint };

// ── Local Projects Cache ─────────────────────────────────

/**
 * In-memory cache of projects assigned to this runner. Populated
 * at startup by assignLocalProjects and kept in sync by
 * assignProjectToRunner. Used by hot paths like pty:spawn cwd
 * validation to avoid a server roundtrip on every request.
 */
let localProjectsCache: Project[] | null = null;

/** Returns the locally cached projects, or null if not warmed yet. */
export function getLocalProjects(): Project[] | null {
  return localProjectsCache;
}

// ── Project Assignment ───────────────────────────────────

async function assignLocalProjects(): Promise<void> {
  if (!state.runnerId) return;

  try {
    const projects = await getServices().projects.listProjects('');
    localProjectsCache = projects;

    log.info('Cached local runner projects', {
      namespace: 'runner',
      count: projects.length,
    });
  } catch (err) {
    log.warn('Failed to assign local projects', {
      namespace: 'runner',
      error: err as any,
    });
  }
}

/**
 * Assign a single project to this runner on the central server.
 */
export async function assignProjectToRunner(project: Project): Promise<void> {
  if (!state.runnerId) return;

  try {
    // The v2 session receives project assignment through its control stream.
    // Keep only the local authorization cache current here.
    if (localProjectsCache) {
      const idx = localProjectsCache.findIndex((p) => p.id === project.id);
      if (idx >= 0) localProjectsCache[idx] = project;
      else localProjectsCache.push(project);
    }
    log.info('Assigned new project to runner', {
      namespace: 'runner',
      projectId: project.id,
    });
  } catch {
    // Non-fatal
  }
}

// ── Browser WS Message Handling ─────────────────────────

function handleBrowserWSMessage(
  userId: string,
  data: unknown,
  grpcRespond?: (responseData: unknown) => void,
): void {
  if (!state.browserWSHandler) {
    const type = (data as { type?: string } | null)?.type ?? 'unknown';
    log.warn('No browser WS handler registered — dropping message', {
      namespace: 'runner',
      type,
      userId,
    });
    return;
  }

  const respond = (responseData: unknown) => {
    grpcRespond?.(responseData);
  };

  state.browserWSHandler(userId, data, respond);
}

// ── Event Forwarding ────────────────────────────────────

function forwardEventToCentral(event: WSEvent, userId?: string): void {
  void userId;
  state.connection?.publish(event);
}

// Remote project creation feeds the runner-local authorization cache.
const remoteProjects = remoteProjectIdentityClient;
configureRemoteProjectAssignment(assignProjectToRunner);

// ── Lifecycle ────────────────────────────────────────────

/**
 * Restore the persisted built-in ACP provider selection on startup
 * (provider-toggle persistence). The provider registry is process-global and
 * resets to the FUNNY_PROVIDERS default on restart; without this, a user's
 * toggles are lost and every built-in reappears as active. We reconcile the
 * in-memory registry to the stored set, then re-advertise so the client picker
 * reflects it without waiting for the next heartbeat.
 *
 * Best-effort: a missing override, an offline server, or a runner with no
 * owning user all leave the FUNNY_PROVIDERS default untouched.
 */
async function applyPersistedBuiltinProviders(): Promise<void> {
  try {
    const active = await remoteProjects.getActiveBuiltinProviders();
    if (!active) return; // no stored override — keep the FUNNY_PROVIDERS default
    const want = new Set(active);
    for (const id of GATEABLE_ACP_PROVIDER_IDS) {
      if (want.has(id)) enableBuiltinProvider(id);
      else disableBuiltinProvider(id);
    }
    log.info('Restored persisted built-in provider selection', {
      namespace: 'runner',
      active,
    });
    // Provider state is advertised on the next gRPC session activation.
  } catch (err) {
    log.warn('Failed to restore persisted built-in providers', {
      namespace: 'runner',
      error: (err as Error).message,
    });
  }
}

async function handleGrpcControl(
  command: RunnerGrpcWireMessage,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (signal.aborted) throw new Error('runner command cancelled');

  if (command.startAgent) {
    const input = command.startAgent as Record<string, any>;
    const { startAgent, stopAgent } = await import('./agent-runner-control.js');
    const threadId = String(input.threadId ?? '');
    signal.addEventListener('abort', () => void stopAgent(threadId), { once: true });
    await startAgent(
      threadId,
      String(input.prompt ?? ''),
      String(input.cwd ?? ''),
      input.model || undefined,
      input.permissionMode || undefined,
      input.images,
      input.disallowedTools,
      input.allowedTools,
      input.provider || undefined,
    );
    return {};
  }

  if (command.stopAgent) {
    const { stopAgent } = await import('./agent-runner-control.js');
    await stopAgent(String(command.stopAgent.threadId ?? ''));
    return {};
  }

  if (command.sendAgentMessage) {
    const input = command.sendAgentMessage as Record<string, any>;
    const { sendMessage } = await import('./thread-service/messaging.js');
    const result = await sendMessage({
      threadId: String(input.threadId ?? ''),
      // The v2 command deliberately carries no caller-controlled identity.
      // sendMessage resolves the authoritative owner from the thread record;
      // this empty value only satisfies the service's HTTP-facing parameter.
      userId: '',
      content: String(input.content ?? ''),
      model: input.model || undefined,
      permissionMode: input.permissionMode || undefined,
      images: input.images,
    });
    if (result.isErr()) throw new Error(result.error.message);
    return result.value as unknown as Record<string, unknown>;
  }

  if (command.assignProject) {
    return {};
  }

  if (command.unassignProject) {
    const projectId = String(command.unassignProject.projectId ?? '');
    if (localProjectsCache) {
      localProjectsCache = localProjectsCache.filter((project) => project.id !== projectId);
    }
    return {};
  }

  throw new Error('Unsupported runner control command');
}

async function connectGrpc(endpoint: string): Promise<void> {
  if (!state.runnerId || !state.runnerToken) {
    throw new Error('gRPC runner transport requires registered credentials');
  }
  const providerState = await advertisedProviderState();
  state.connection ??= new RunnerConnectionSupervisor(
    endpoint,
    (options) => new GrpcTeamTransport(options),
  );
  configureRemoteDataTransport(state.connection);
  state.connection.activate({
    token: state.runnerToken,
    runner: {
      instanceId: state.runnerId,
      name: `${hostname()}-funny`,
      hostname: hostname(),
      operatingSystem: process.platform,
      workspace: process.cwd(),
      activeProviderIds: providerState.activeBuiltins,
    },
    handleTunnel: async (request) => {
      if (!state.localApp) return new Response('Local app not initialized', { status: 503 });
      return state.localApp.fetch(request);
    },
    handleTerminal: (command: GrpcTerminalCommand, respond) => {
      if (!command.userId) return;
      handleBrowserWSMessage(command.userId, { type: command.type, data: command.data }, (event) =>
        respond(event as WSEvent),
      );
    },
    handleControl: handleGrpcControl,
    onActivated: () => {
      log.info('Runner gRPC session activated', {
        namespace: 'runner',
        runnerId: state.runnerId,
      });
    },
    onDisconnected: (error) => {
      log.warn('Runner gRPC session disconnected', {
        namespace: 'runner',
        error: error?.message,
      });
    },
  });
}

/**
 * Initialize runner mode — connect to the central server.
 * Called from app.ts init() when TEAM_SERVER_URL is set.
 */
export async function initTeamMode(serverUrl: string): Promise<void> {
  const grpcEndpoint = requireRunnerGrpcEndpoint();
  state.serverUrl = serverUrl.replace(/\/$/, '');

  log.info(`Connecting to server at ${state.serverUrl}`, {
    namespace: 'runner',
  });

  // Load runner-installed provider extensions before registering so this runner
  // advertises them to the server (provider-manifest-loader §3). Errors are
  // collected per-extension; one bad manifest never blocks the others.
  try {
    const { loaded, errors } = loadProviderExtensions(join(DATA_DIR, 'extensions'));
    if (loaded.length) {
      log.info(`Loaded ${loaded.length} provider extension(s)`, {
        namespace: 'runner',
        providers: loaded.map((l) => l.id),
      });
    }
    for (const e of errors) {
      log.warn('Skipped invalid provider extension', {
        namespace: 'runner',
        ...e,
      });
    }
  } catch (err) {
    log.error('Provider extension load failed', {
      namespace: 'runner',
      error: String(err),
    });
  }

  // Subscribe to local wsBroker events early
  state.unsubscribeBroker = wsBroker.onEvent(forwardEventToCentral);

  state.enrollment = new RunnerEnrollmentClient(state.serverUrl, async () => ({
    name: `${hostname()}-funny`,
    hostname: hostname(),
    os: process.platform,
    publicMediaUrl: process.env.RUNNER_PUBLIC_MEDIA_URL?.trim() || undefined,
    ...(await advertisedProviderState()),
  }));
  const session = await state.enrollment.bootstrap();
  state.runnerId = session.runnerId;
  state.runnerToken = session.token;

  await connectGrpc(grpcEndpoint);
  await assignLocalProjects();

  // Restore the user's persisted built-in provider selection (best-effort,
  // non-blocking — waits for the socket internally via sendDataMessage).
  void applyPersistedBuiltinProviders();

  log.info('Runner mode initialized', {
    namespace: 'runner',
    runnerId: state.runnerId,
    transport: 'grpc-v2',
  });
}

/**
 * Shutdown runner mode — clean up connections and timers.
 */
export function shutdownTeamMode(): void {
  if (state.unsubscribeBroker) state.unsubscribeBroker();
  state.connection?.shutdown('runner mode shutdown');
  state.connection = null;
  configureRemoteDataTransport(null);

  state.unsubscribeBroker = null;
  state.runnerId = null;
  state.runnerToken = null;
  state.enrollment?.clearSession();
  state.enrollment = null;

  log.info('Runner mode shutdown', { namespace: 'runner' });
}

/** Get the central server URL (or null if not connected) */
export function getTeamServerUrl(): string | null {
  return state.serverUrl || null;
}

/**
 * Register a handler for browser WS messages forwarded through the server.
 */
export function setBrowserWSHandler(handler: BrowserWSHandler): void {
  state.browserWSHandler = handler;
}

/**
 * Register the local Hono app for handling tunneled HTTP requests from the server.
 */
export function setLocalApp(app: FetchableApp): void {
  state.localApp = app;
}
