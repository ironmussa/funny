/**
 * @domain subdomain: Team Collaboration
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 *
 * Team client — connects this local funny instance to a central team server.
 * Activated when TEAM_SERVER_URL is set (via `funny --team <url>`).
 *
 * Responsibilities:
 * - Authenticate with the central server
 * - Register as a runner
 * - Heartbeat (every 15s)
 * - Poll for pending tasks (every 5s)
 * - Sync team projects (on startup + periodically)
 * - Connect WebSocket for agent event streaming
 */

import { hostname } from 'os';

import type { Project, WSEvent } from '@funny/shared';
import type { RunnerRegisterResponse, RunnerTask } from '@funny/shared/runner-protocol';

import { log } from '../lib/logger.js';
import { listProjects } from './project-manager.js';
import { wsBroker } from './ws-broker.js';

export type BrowserWSHandler = (
  userId: string,
  data: unknown,
  respond: (responseData: unknown) => void,
) => void;

interface TeamClientState {
  serverUrl: string;
  runnerId: string | null;
  runnerToken: string | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  ws: WebSocket | null;
  unsubscribeBroker: (() => void) | null;
  browserWSHandler: BrowserWSHandler | null;
}

const state: TeamClientState = {
  serverUrl: '',
  runnerId: null,
  runnerToken: null,
  heartbeatTimer: null,
  pollTimer: null,
  ws: null,
  unsubscribeBroker: null,
  browserWSHandler: null,
};

// ── HTTP helpers ─────────────────────────────────────────

async function centralFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (state.runnerToken) {
    headers['Authorization'] = `Bearer ${state.runnerToken}`;
  }

  return fetch(`${state.serverUrl}${path}`, { ...options, headers });
}

// ── Registration ─────────────────────────────────────────

async function register(): Promise<boolean> {
  try {
    const port = process.env.PORT || '3001';
    const httpUrl = `http://${hostname()}:${port}`;

    const res = await centralFetch('/api/runners/register', {
      method: 'POST',
      body: JSON.stringify({
        name: `${hostname()}-funny`,
        hostname: hostname(),
        os: process.platform,
        httpUrl,
      }),
    });

    if (!res.ok) {
      log.error('Failed to register with central server', {
        namespace: 'team',
        status: res.status,
      });
      return false;
    }

    const data = (await res.json()) as RunnerRegisterResponse;
    state.runnerId = data.runnerId;
    state.runnerToken = data.token;

    log.info('Registered with central server', {
      namespace: 'team',
      runnerId: data.runnerId,
      httpUrl,
    });

    return true;
  } catch (err) {
    log.error('Failed to connect to central server', {
      namespace: 'team',
      error: err as any,
    });
    return false;
  }
}

// ── Heartbeat ────────────────────────────────────────────

async function sendHeartbeat(): Promise<void> {
  try {
    await centralFetch('/api/runners/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        activeThreadIds: [], // TODO: populate from agent-runner
      }),
    });
  } catch (err) {
    log.warn('Heartbeat failed', { namespace: 'team', error: err as any });
  }
}

// ── Task Polling ─────────────────────────────────────────

async function pollTasks(): Promise<void> {
  try {
    const res = await centralFetch('/api/runners/tasks');
    if (!res.ok) return;

    const { tasks } = (await res.json()) as { tasks: RunnerTask[] };
    for (const task of tasks) {
      log.info('Received task from central', {
        namespace: 'team',
        taskId: task.taskId,
        type: task.type,
        threadId: task.threadId,
      });
      // TODO: Execute task locally and report result
    }
  } catch {
    // Silent — central may be temporarily unreachable
  }
}

// ── Project Assignment ───────────────────────────────────

/**
 * Assign all local projects to this runner on the central server.
 * This populates the server's runnerProjectAssignments table so it
 * can route requests by projectId to this runner.
 */
async function assignLocalProjects(): Promise<void> {
  if (!state.runnerId) return;

  try {
    // Query all local projects (using '__local__' to get all in local DB)
    const projects = await listProjects('__local__');

    for (const project of projects) {
      try {
        await centralFetch(`/api/runners/${state.runnerId}/projects`, {
          method: 'POST',
          body: JSON.stringify({
            projectId: project.id,
            localPath: project.path,
          }),
        });
      } catch {
        // Individual assignment failures are non-fatal
      }
    }

    log.info('Assigned local projects to runner', {
      namespace: 'team',
      count: projects.length,
    });
  } catch (err) {
    log.warn('Failed to assign local projects', {
      namespace: 'team',
      error: err as any,
    });
  }
}

/**
 * Assign a single project to this runner on the central server.
 * Called when a new project is created on the Runtime.
 */
export async function assignProjectToRunner(project: Project): Promise<void> {
  if (!state.runnerId) return;

  try {
    await centralFetch(`/api/runners/${state.runnerId}/projects`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: project.id,
        localPath: project.path,
      }),
    });
    log.info('Assigned new project to runner', {
      namespace: 'team',
      projectId: project.id,
    });
  } catch {
    // Non-fatal
  }
}

// ── WebSocket Connection ─────────────────────────────────

function connectWebSocket(): void {
  const wsUrl = state.serverUrl.replace(/^http/, 'ws') + '/ws/runner';

  try {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // Authenticate
      ws.send(JSON.stringify({ type: 'runner:auth', token: state.runnerToken }));
      log.info('WebSocket connected to central', { namespace: 'team' });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === 'runner:auth_ok') {
          log.info('WebSocket authenticated', { namespace: 'team' });
        }

        // Handle browser WS messages forwarded through the central server
        if (data.type === 'central:browser_ws' && data.userId && data.data) {
          handleBrowserWSMessage(data.userId, data.data);
        }

        // Handle task commands from central
        if (data.type === 'central:command' && data.task) {
          log.info('Received command from central', {
            namespace: 'team',
            taskId: data.task.taskId,
            type: data.task.type,
          });
          // TODO: Execute task locally and report result
        }
      } catch {}
    };

    ws.onclose = () => {
      log.warn('WebSocket disconnected from central, reconnecting in 5s...', { namespace: 'team' });
      state.ws = null;
      setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };

    state.ws = ws;
  } catch (err) {
    log.error('Failed to connect WebSocket to central', { namespace: 'team', error: err as any });
    setTimeout(connectWebSocket, 5000);
  }
}

// ── Browser WS Message Handling ─────────────────────────

/**
 * Handle a browser WS message forwarded through the central server.
 * Delegates to the registered handler (set by runtime's index.ts).
 */
function handleBrowserWSMessage(userId: string, data: unknown): void {
  if (!state.browserWSHandler) {
    log.warn('No browser WS handler registered', { namespace: 'team' });
    return;
  }

  const respond = (responseData: unknown) => {
    // Send the response back to the central server for relay to the browser
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    try {
      state.ws.send(
        JSON.stringify({
          type: 'runner:browser_relay',
          userId,
          data: responseData,
        }),
      );
    } catch {}
  };

  state.browserWSHandler(userId, data, respond);
}

// ── Event Forwarding ────────────────────────────────────

/**
 * Forward a local wsBroker event to the central server via WebSocket.
 * The server relays it to the appropriate browser client.
 */
function forwardEventToCentral(event: WSEvent, userId?: string): void {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

  try {
    state.ws.send(
      JSON.stringify({
        type: 'runner:agent_event',
        threadId: (event as any).threadId,
        userId,
        event,
      }),
    );
  } catch {
    // WS may have closed between the check and send — ignore
  }
}

// ── Lifecycle ────────────────────────────────────────────

/**
 * Initialize team mode — connect to the central server.
 * Called from server/src/index.ts when TEAM_SERVER_URL is set.
 */
export async function initTeamMode(serverUrl: string): Promise<void> {
  state.serverUrl = serverUrl.replace(/\/$/, ''); // Remove trailing slash

  log.info(`Connecting to central server at ${state.serverUrl}`, { namespace: 'team' });

  // Register as a runner
  const registered = await register();
  if (!registered) {
    log.error('Failed to register with central server — team mode disabled', { namespace: 'team' });
    return;
  }

  // Start heartbeat (every 15s)
  state.heartbeatTimer = setInterval(sendHeartbeat, 15_000);
  if (state.heartbeatTimer.unref) state.heartbeatTimer.unref();

  // Start task polling (every 5s)
  state.pollTimer = setInterval(pollTasks, 5_000);
  if (state.pollTimer.unref) state.pollTimer.unref();

  // Connect WebSocket for event streaming
  connectWebSocket();

  // Subscribe to local wsBroker events and forward to central server
  state.unsubscribeBroker = wsBroker.onEvent(forwardEventToCentral);

  // Assign local projects to this runner on the server
  await assignLocalProjects();

  log.info('Team mode initialized', { namespace: 'team', runnerId: state.runnerId });
}

/**
 * Shutdown team mode — clean up connections and timers.
 */
export function shutdownTeamMode(): void {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.unsubscribeBroker) state.unsubscribeBroker();
  if (state.ws) state.ws.close();

  state.heartbeatTimer = null;
  state.pollTimer = null;
  state.unsubscribeBroker = null;
  state.ws = null;
  state.runnerId = null;
  state.runnerToken = null;

  log.info('Team mode shutdown', { namespace: 'team' });
}

/** Check if team mode is active */
export function isTeamModeActive(): boolean {
  return !!state.runnerId;
}

/** Get the central server URL (or null if not in team mode) */
export function getTeamServerUrl(): string | null {
  return state.serverUrl || null;
}

/**
 * Register a handler for browser WS messages forwarded through the central server.
 * Called by runtime's index.ts to handle PTY commands, etc.
 */
export function setBrowserWSHandler(handler: BrowserWSHandler): void {
  state.browserWSHandler = handler;
}
