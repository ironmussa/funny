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
 * Uses Socket.IO for all real-time communication (replaces raw WebSocket
 * + HTTP long-polling). Socket.IO provides automatic reconnection,
 * heartbeat, and transport fallback.
 *
 * Responsibilities:
 * - Authenticate with the central server (HTTP registration)
 * - Maintain Socket.IO connection for events + tunnel + data persistence
 * - Heartbeat (every 15s)
 * - Poll for pending tasks (every 5s)
 * - Assign local projects to the server (on startup + when created)
 */

import { hostname } from 'os';

import type { Project, WSEvent } from '@funny/shared';
import {
  TUNNEL_MAX_RESPONSE_BODY_BYTES,
  type DataInsertMessage,
  type DataInsertToolCall,
  type RunnerRegisterResponse,
  type RunnerTask,
} from '@funny/shared/runner-protocol';
import { nanoid } from 'nanoid';
import { io, type Socket } from 'socket.io-client';

import { log } from '../lib/logger.js';
import { getServices } from './service-registry.js';
import { wsBroker } from './ws-broker.js';

/** When true, ALL runner↔server communication uses WebSocket (no HTTP except initial registration) */
const WS_ONLY = process.env.WS_TUNNEL_ONLY === 'true' || process.env.WS_TUNNEL_ONLY === '1';

export type BrowserWSHandler = (
  userId: string,
  data: unknown,
  respond: (responseData: unknown) => void,
) => void;

/** A Hono-like app that can handle fetch requests */
type FetchableApp = { fetch: (request: Request) => Promise<Response> | Response };

/** Timeout for data requests awaiting server response (ms) */
const DATA_REQUEST_TIMEOUT = 15_000;

interface TeamClientState {
  serverUrl: string;
  runnerId: string | null;
  runnerToken: string | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  socket: Socket | null;
  unsubscribeBroker: (() => void) | null;
  browserWSHandler: BrowserWSHandler | null;
  /** Reference to the local Hono app for handling tunnel requests */
  localApp: FetchableApp | null;
}

const state: TeamClientState = {
  serverUrl: '',
  runnerId: null,
  runnerToken: null,
  heartbeatTimer: null,
  pollTimer: null,
  socket: null,
  unsubscribeBroker: null,
  browserWSHandler: null,
  localApp: null,
};

// ── HTTP helpers ─────────────────────────────────────────

async function centralFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  // Use runner token if available (post-registration), otherwise use shared secret
  if (state.runnerToken) {
    headers['Authorization'] = `Bearer ${state.runnerToken}`;
  }
  if (process.env.RUNNER_AUTH_SECRET) {
    headers['X-Runner-Auth'] = process.env.RUNNER_AUTH_SECRET;
  }

  return fetch(`${state.serverUrl}${path}`, { ...options, headers });
}

// ── Registration ─────────────────────────────────────────

async function register(): Promise<boolean> {
  try {
    // Register with httpUrl so the server can use direct HTTP as fallback
    // when the WebSocket tunnel is unavailable. For remote runners behind NAT,
    // set RUNNER_HTTP_URL='' or WS_TUNNEL_ONLY=true to disable direct HTTP.
    const runnerPort = Number(process.env.RUNNER_PORT) || 3003;
    const httpUrl = WS_ONLY
      ? ''
      : (process.env.RUNNER_HTTP_URL ?? `http://127.0.0.1:${runnerPort}`);

    const inviteToken = process.env.RUNNER_INVITE_TOKEN;
    const extraHeaders: Record<string, string> = inviteToken
      ? { 'X-Runner-Invite-Token': inviteToken }
      : {};

    const res = await centralFetch('/api/runners/register', {
      method: 'POST',
      headers: extraHeaders,
      body: JSON.stringify({
        name: `${hostname()}-funny`,
        hostname: hostname(),
        os: process.platform,
        httpUrl: httpUrl || undefined,
      }),
    });

    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {}
      log.error('Failed to register with central server', {
        namespace: 'runner',
        status: res.status,
        body,
      });
      return false;
    }

    const data = (await res.json()) as RunnerRegisterResponse;
    state.runnerId = data.runnerId;
    state.runnerToken = data.token;

    // Verify the registration by doing a test heartbeat
    try {
      const hbRes = await centralFetch('/api/runners/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ activeThreadIds: [] }),
      });
      if (hbRes.status === 404) {
        log.warn('Registration returned stale runner — server may be using wrong DB', {
          namespace: 'runner',
          runnerId: data.runnerId,
        });
        state.runnerId = null;
        state.runnerToken = null;
        return false;
      }
    } catch {
      // Non-fatal — heartbeat verification is best-effort
    }

    log.info('Registered with central server', {
      namespace: 'runner',
      runnerId: data.runnerId,
      transport: httpUrl ? 'http+socketio' : 'socketio-only',
    });

    return true;
  } catch (err) {
    log.error('Failed to connect to central server', {
      namespace: 'runner',
      error: err as any,
    });
    return false;
  }
}

/**
 * Retry registration with exponential backoff.
 * Retries indefinitely — the server may not be ready when the runner starts.
 */
async function registerWithRetry(): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    const ok = await register();
    if (ok) return true;

    const delay = Math.min(2000 * attempt, 15_000);
    log.warn(`Registration failed, retrying in ${delay / 1000}s (attempt ${attempt})`, {
      namespace: 'runner',
    });
    await new Promise((r) => setTimeout(r, delay));
  }
}

// ── Heartbeat ────────────────────────────────────────────

async function sendHeartbeat(): Promise<void> {
  if (WS_ONLY) return sendHeartbeatWS();

  try {
    const res = await centralFetch('/api/runners/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        activeThreadIds: [], // TODO: populate from agent-runner
      }),
    });

    // Server purged our runner record (e.g. after restart) — re-register
    if (res.status === 404) {
      log.warn('Runner not found on server — re-registering', { namespace: 'runner' });
      state.runnerId = null;
      state.runnerToken = null;
      const ok = await register();
      if (ok) {
        // Reconnect Socket.IO with new token
        if (state.socket) {
          state.socket.disconnect();
        }
        connectSocket();
        await assignLocalProjects();
        log.info('Runner re-registered after server restart', {
          namespace: 'runner',
          runnerId: state.runnerId,
        });
      }
      return;
    }

    // The server reports whether it sees our Socket.IO tunnel as connected.
    // Detects zombie sockets where the client thinks it's connected but the
    // server's runnerSockets map has no record (e.g. ping-timeout drop the
    // client missed). Without this, agent events stay stranded in the local
    // ws-broker and never reach the browser.
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { wsConnected?: boolean } | null;
      if (body && body.wsConnected === false) {
        log.warn('Server reports WS tunnel disconnected — forcing reconnect', {
          namespace: 'runner',
          socketConnected: state.socket?.connected ?? false,
        });
        connectSocket();
      }
    }
  } catch (err) {
    log.warn('Heartbeat failed', { namespace: 'runner', error: err as any });
  }
}

// ── WS-only Heartbeat ────────────────────────────────────

let _wsHeartbeatFailures = 0;
const WS_HEARTBEAT_FAILURE_THRESHOLD = 3;

async function sendHeartbeatWS(): Promise<void> {
  try {
    const response = await sendDataMessage('runner:heartbeat', {
      activeThreadIds: [],
    });

    _wsHeartbeatFailures = 0;

    // Handle re-registration if runner not found
    if (response?.code === 'RUNNER_NOT_FOUND') {
      log.warn('Runner not found on server — re-registering', { namespace: 'runner' });
      state.runnerId = null;
      state.runnerToken = null;
      const ok = await register();
      if (ok) {
        if (state.socket) {
          state.socket.disconnect();
        }
        connectSocket();
        await assignLocalProjects();
      }
    }
  } catch (err) {
    _wsHeartbeatFailures++;
    log.warn('WS heartbeat failed', {
      namespace: 'runner',
      error: (err as Error).message,
      consecutiveFailures: _wsHeartbeatFailures,
    });
    // Repeated failures indicate a zombie socket — recreate it.
    if (_wsHeartbeatFailures >= WS_HEARTBEAT_FAILURE_THRESHOLD) {
      _wsHeartbeatFailures = 0;
      log.warn('WS heartbeat failed repeatedly — forcing reconnect', { namespace: 'runner' });
      connectSocket();
    }
  }
}

// ── WS-only Task Polling ─────────────────────────────────

async function pollTasksWS(): Promise<void> {
  try {
    const response = await sendDataMessage('runner:poll_tasks', {});

    const tasks = response?.tasks ?? [];
    for (const task of tasks) {
      log.info('Received task from central (WS)', {
        namespace: 'runner',
        taskId: task.taskId,
        type: task.type,
        threadId: task.threadId,
      });
    }
  } catch {
    // Silent — Socket.IO may be temporarily disconnected
  }
}

// ── WS-only Project Assignment ───────────────────────────

async function assignProjectWS(projectId: string, localPath: string): Promise<void> {
  if (!state.runnerId) return;
  try {
    await sendDataMessage('runner:assign_project', {
      runnerId: state.runnerId,
      projectId,
      localPath,
    });
  } catch {
    // Non-fatal
  }
}

// ── Task Polling ─────────────────────────────────────────

async function pollTasks(): Promise<void> {
  if (WS_ONLY) return pollTasksWS();

  try {
    const res = await centralFetch('/api/runners/tasks');
    if (!res.ok) return;

    const { tasks } = (await res.json()) as { tasks: RunnerTask[] };
    for (const task of tasks) {
      log.info('Received task from central', {
        namespace: 'runner',
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

    for (const project of projects) {
      try {
        if (WS_ONLY) {
          await assignProjectWS(project.id, project.path);
        } else {
          await centralFetch(`/api/runners/${state.runnerId}/projects`, {
            method: 'POST',
            body: JSON.stringify({
              projectId: project.id,
              localPath: project.path,
            }),
          });
        }
      } catch {
        // Individual assignment failures are non-fatal
      }
    }

    log.info('Assigned local projects to runner', {
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
    if (WS_ONLY) {
      await assignProjectWS(project.id, project.path);
    } else {
      await centralFetch(`/api/runners/${state.runnerId}/projects`, {
        method: 'POST',
        body: JSON.stringify({
          projectId: project.id,
          localPath: project.path,
        }),
      });
    }
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

// ── Socket.IO Connection ─────────────────────────────────

/**
 * Connect to the central server via Socket.IO.
 * Socket.IO handles: reconnection, heartbeat, transport fallback.
 */
let _reregistering = false;
let _reregisterAttempts = 0;
const MAX_REREGISTER_ATTEMPTS = 5;

function connectSocket(): void {
  if (!state.runnerToken) {
    log.warn('Cannot connect Socket.IO — no runner token', { namespace: 'runner' });
    return;
  }

  // Tear down previous socket completely before creating a new one
  if (state.socket) {
    state.socket.removeAllListeners();
    state.socket.disconnect();
    state.socket = null;
  }

  const serverUrl = state.serverUrl;

  log.info('Connecting via Socket.IO', { namespace: 'runner', url: serverUrl });

  const socket = io(`${serverUrl}/runner`, {
    auth: { token: state.runnerToken },
    // Socket.IO handles reconnection automatically
    reconnection: true,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 30_000,
    reconnectionAttempts: Infinity,
    // Socket.IO handles transport negotiation (WS + polling fallback)
    transports: ['websocket', 'polling'],
    // Timeout for the initial connection
    timeout: 20_000,
  });

  socket.on('connect', () => {
    _reregisterAttempts = 0; // Reset on successful connection
    log.info('Socket.IO connected to server', {
      namespace: 'runner',
      transport: socket.io.engine?.transport?.name ?? 'unknown',
    });
  });

  socket.on('disconnect', (reason) => {
    log.warn('Socket.IO disconnected from server', {
      namespace: 'runner',
      reason,
    });
  });

  socket.on('connect_error', async (err) => {
    log.warn('Socket.IO connection error', {
      namespace: 'runner',
      error: err.message,
    });

    // Token rejected — re-register to get a fresh token (with guard against concurrent attempts)
    if (
      (err.message === 'Invalid runner token' || err.message === 'No runner token') &&
      !_reregistering &&
      _reregisterAttempts < MAX_REREGISTER_ATTEMPTS
    ) {
      _reregistering = true;
      _reregisterAttempts++;
      try {
        log.warn(
          `Runner token invalid — re-registering (attempt ${_reregisterAttempts}/${MAX_REREGISTER_ATTEMPTS})`,
          { namespace: 'runner' },
        );
        socket.removeAllListeners();
        socket.disconnect();
        state.runnerId = null;
        state.runnerToken = null;
        const ok = await register();
        if (ok) {
          _reregisterAttempts = 0; // Reset on success
          connectSocket();
          await assignLocalProjects();
        }
      } finally {
        _reregistering = false;
      }
    } else if (_reregisterAttempts >= MAX_REREGISTER_ATTEMPTS) {
      log.error(
        `Max re-registration attempts (${MAX_REREGISTER_ATTEMPTS}) reached. Restart the runtime.`,
        { namespace: 'runner' },
      );
      socket.removeAllListeners();
      socket.disconnect();
    }
  });

  socket.io.on('reconnect', (attempt) => {
    log.info('Socket.IO reconnected', {
      namespace: 'runner',
      attempt,
    });
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    if (attempt % 5 === 0) {
      log.warn('Socket.IO reconnect attempt', {
        namespace: 'runner',
        attempt,
      });
    }
  });

  socket.io.on('reconnect_error', (err) => {
    log.warn('Socket.IO reconnect error', {
      namespace: 'runner',
      error: err.message,
    });
  });

  // `reconnection_failed` fires only when reconnectionAttempts is finite and
  // exhausted. With Infinity (our setting) it should never fire — log it
  // loudly if it does so we notice silent give-ups instead of staring at
  // dead connections.
  socket.io.on('reconnect_failed', () => {
    log.error('Socket.IO reconnect_failed — auto-reconnect gave up; forcing manual reconnect', {
      namespace: 'runner',
    });
    connectSocket();
  });

  // Handle tunnel requests with ack callback
  socket.on('tunnel:request', async (data: any, ack: (response: any) => void) => {
    const response = await handleTunnelRequest(data);
    ack(response);
  });

  // Single persistent listener for server data responses (Security L2).
  // The server emits `data:response` with `{ requestId, response }`; we look
  // up the pending entry in `pendingDataRequests` and resolve it. This
  // replaces the previous pattern of registering a fresh `once()` listener
  // per in-flight request on a dynamic `data:response:<id>` event name.
  socket.on('data:response', (msg: { requestId?: string; response?: any }) => {
    if (!msg || typeof msg.requestId !== 'string') return;
    const pending = pendingDataRequests.get(msg.requestId);
    if (!pending) return;
    pendingDataRequests.delete(msg.requestId);
    clearTimeout(pending.timer);
    const r = msg.response;
    if (r?.success === false && r?.error) {
      pending.reject(new Error(r.error));
    } else {
      pending.resolve(r);
    }
  });

  socket.on('disconnect', () => {
    // Fail every in-flight data request on disconnect so callers aren't
    // stuck waiting for the full 15s timeout.
    if (pendingDataRequests.size > 0) {
      log.warn('Failing in-flight data requests due to socket disconnect', {
        namespace: 'runner',
        count: pendingDataRequests.size,
      });
      for (const [, p] of pendingDataRequests) {
        clearTimeout(p.timer);
        p.reject(new Error('Socket.IO disconnected while awaiting data response'));
      }
      pendingDataRequests.clear();
    }
  });

  // Handle browser WS messages forwarded through the central server
  socket.on('central:browser_ws', (data: any) => {
    if (data.userId && data.data) {
      handleBrowserWSMessage(data.userId, data.data);
    }
  });

  // Ack-based RPC for pty:list. The browser asks the server for the list of
  // active PTY sessions; the server forwards via this event and waits for the
  // ack so the browser receives a single deterministic response (no orphaned
  // pty:sessions events that may or may not arrive).
  socket.on('central:pty_list', async (data: any, ack?: (response: unknown) => void) => {
    if (typeof ack !== 'function') return;
    try {
      const userId = data?.userId;
      if (typeof userId !== 'string' || !userId) {
        ack({ sessions: [] });
        return;
      }
      const ptyManager = await import('./pty-manager.js');
      const sessions = ptyManager.listActiveSessions(userId).map((s) => ({
        ptyId: s.ptyId,
        cwd: s.cwd,
        projectId: s.projectId,
        label: s.label,
        shell: s.shell,
      }));
      ack({ sessions });
    } catch (err) {
      log.error('central:pty_list handler failed', {
        namespace: 'runner',
        error: (err as Error).message,
      });
      ack({ sessions: [], error: (err as Error).message });
    }
  });

  // Handle task commands from central
  socket.on('central:command', (data: any) => {
    if (data.task) {
      log.info('Received command from central', {
        namespace: 'runner',
        taskId: data.task.taskId,
        type: data.task.type,
      });
      // TODO: Execute task locally and report result
    }
  });

  state.socket = socket;
}

// ── Browser WS Message Handling ─────────────────────────

function handleBrowserWSMessage(userId: string, data: unknown): void {
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
    if (!state.socket?.connected) return;
    state.socket.emit('runner:browser_relay', { userId, data: responseData });
  };

  state.browserWSHandler(userId, data, respond);
}

// ── Event Forwarding ────────────────────────────────────

function forwardEventToCentral(event: WSEvent, userId?: string): void {
  if (!state.socket?.connected) {
    log.warn('Cannot forward event — Socket.IO not connected', {
      namespace: 'runner',
      eventType: event.type,
      threadId: (event as any).threadId,
    });
    return;
  }

  if (!userId) {
    log.warn('Forwarding event without userId — may be dropped by central', {
      namespace: 'runner',
      eventType: event.type,
      threadId: (event as any).threadId,
    });
  }

  state.socket.emit('runner:agent_event', {
    threadId: (event as any).threadId,
    userId,
    event,
  });
}

// ── Tunnel Request Handling ──────────────────────────────

/**
 * Handle a tunneled HTTP request from the server.
 * Returns the response (used as Socket.IO ack callback data).
 */
async function handleTunnelRequest(data: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}): Promise<{ status: number; headers: Record<string, string>; body: string | null }> {
  if (!state.localApp) {
    log.warn('Received tunnel:request but no local app registered', { namespace: 'runner' });
    return { status: 503, headers: {}, body: 'Local app not initialized' };
  }

  try {
    const url = `http://localhost${data.path}`;
    const init: RequestInit = {
      method: data.method,
      headers: data.headers,
    };
    if (data.body && data.method !== 'GET' && data.method !== 'HEAD') {
      init.body = data.body;
    }

    const request = new Request(url, init);
    const response = await state.localApp.fetch(request);

    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Short-circuit oversized responses with a structured 413. If we let it
    // through, Socket.IO would silently drop the ack (over `maxHttpBufferSize`)
    // and the request would appear to hang until the 30s tunnel timeout —
    // making this look like the runner crashed.
    const bodyBytes = Buffer.byteLength(responseBody, 'utf8');
    if (bodyBytes > TUNNEL_MAX_RESPONSE_BODY_BYTES) {
      log.warn('Tunnel response too large — short-circuiting with 413', {
        namespace: 'runner',
        path: data.path,
        bodyBytes,
        limitBytes: TUNNEL_MAX_RESPONSE_BODY_BYTES,
      });
      return {
        status: 413,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error: 'Tunnel response exceeds size limit',
          bodyBytes,
          limitBytes: TUNNEL_MAX_RESPONSE_BODY_BYTES,
          hint: 'Increase maxHttpBufferSize in server socketio config or paginate the response.',
        }),
      };
    }

    return { status: response.status, headers: responseHeaders, body: responseBody };
  } catch (err) {
    log.error('Failed to handle tunnel request', {
      namespace: 'runner',
      path: data.path,
      error: (err as Error).message,
    });
    return { status: 500, headers: {}, body: JSON.stringify({ error: 'Internal runner error' }) };
  }
}

// ── Data Persistence (Runner → Server) ──────────────────

/**
 * Simple concurrency limiter for WebSocket data requests.
 * Prevents overwhelming the data channel with hundreds of simultaneous requests
 * (e.g., when git watcher fires for all threads at once).
 */
const MAX_CONCURRENT_DATA_REQUESTS = 20;
// Reject if a caller waits longer than this in the slot queue — prevents
// indefinite hangs when the server stops responding (e.g. rate-limit drops).
const DATA_SLOT_ACQUIRE_TIMEOUT = 20_000;
let activeDataRequests = 0;
type QueueEntry = { grant: () => void; abort: () => void };
const dataRequestQueue: QueueEntry[] = [];

function acquireDataSlot(): Promise<void> {
  if (activeDataRequests < MAX_CONCURRENT_DATA_REQUESTS) {
    activeDataRequests++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const entry: QueueEntry = {
      grant: () => {
        clearTimeout(timer);
        activeDataRequests++;
        resolve();
      },
      abort: () => {
        reject(new Error('Data slot acquire timed out'));
      },
    };
    const timer = setTimeout(() => {
      const idx = dataRequestQueue.indexOf(entry);
      if (idx >= 0) dataRequestQueue.splice(idx, 1);
      entry.abort();
    }, DATA_SLOT_ACQUIRE_TIMEOUT);
    dataRequestQueue.push(entry);
  });
}

function releaseDataSlot(): void {
  activeDataRequests--;
  const next = dataRequestQueue.shift();
  if (next) next.grant();
}

/**
 * In-flight data request registry (Security L2).
 *
 * Keyed by the unique `requestId` sent with each `data:*` emit. A single
 * persistent `data:response` listener (installed in `connectSocket`) dispatches
 * server responses into the matching entry, so we no longer register a fresh
 * `socket.once('data:response:<id>')` listener per request.
 */
const pendingDataRequests = new Map<
  string,
  {
    resolve: (value: any) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/**
 * Send a data message to the server using event-based request/response.
 *
 * Uses a unique requestId to correlate requests with responses. The server
 * emits back on `data:response` with `{ requestId, response }` instead of
 * using Socket.IO ack callbacks. This avoids a deadlock where ack packets
 * can't be delivered while the runner is processing a tunnel:request on the
 * same connection (Bun's WebSocket / @socket.io/bun-engine limitation).
 *
 * Concurrency-limited to MAX_CONCURRENT_DATA_REQUESTS to prevent channel saturation.
 */
async function sendDataMessage(eventType: string, payload: Record<string, any>): Promise<any> {
  await acquireDataSlot();
  try {
    if (!state.socket?.connected) {
      // Wait briefly for reconnection (Socket.IO handles this automatically)
      await new Promise<void>((resolve, reject) => {
        if (!state.socket) {
          reject(new Error('Socket.IO not initialized'));
          return;
        }
        const timeout = setTimeout(() => {
          reject(new Error('Socket.IO not connected to central server'));
        }, 5_000);

        if (state.socket.connected) {
          clearTimeout(timeout);
          resolve();
        } else {
          state.socket.once('connect', () => {
            clearTimeout(timeout);
            resolve();
          });
        }
      });
    }

    const requestId = nanoid();

    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingDataRequests.delete(requestId);
        reject(new Error(`Data request timed out (${eventType})`));
      }, DATA_REQUEST_TIMEOUT);

      pendingDataRequests.set(requestId, { resolve, reject, timer });
      state.socket!.emit(eventType, { ...payload, _requestId: requestId });
    });

    // Register a no-op handler on the underlying promise so a socket-disconnect
    // rejection (rejected for *every* pending request at once in the `disconnect`
    // listener) doesn't surface as an unhandled rejection when a caller has
    // already moved on. `await pending` below still propagates the error to
    // direct awaiters; this only suppresses the global unhandled-rejection
    // signal on the original promise.
    pending.catch(() => {});

    return await pending;
  } finally {
    releaseDataSlot();
  }
}

/** Insert a message on the server, returns the server-generated messageId */
export async function remoteInsertMessage(data: DataInsertMessage['payload']): Promise<string> {
  const response = await sendDataMessage('data:insert_message', { payload: data });
  return response.messageId;
}

/** Insert a tool call on the server, returns the server-generated toolCallId */
export async function remoteInsertToolCall(data: DataInsertToolCall['payload']): Promise<string> {
  const response = await sendDataMessage('data:insert_tool_call', { payload: data });
  return response.toolCallId;
}

/** Update thread fields on the server (request-response, awaits confirmation) */
export async function remoteUpdateThread(
  threadId: string,
  updates: Record<string, any>,
): Promise<void> {
  invalidateThreadCache(threadId);
  await sendDataMessage('data:update_thread', { payload: { threadId, updates } });
}

/** Update message content on the server (fire-and-forget) */
export async function remoteUpdateMessage(messageId: string, content: string): Promise<void> {
  if (!state.socket?.connected) return;
  state.socket.emit('data:update_message', { payload: { messageId, content } });
}

/** Delete every message strictly after the anchor for the given thread.
 *  Returns the number of rows deleted. Used by "Rewind code to here". */
export async function remoteDeleteMessagesAfter(
  threadId: string,
  anchorMessageId: string,
): Promise<number> {
  const response = await sendDataMessage('data:delete_messages_after', {
    payload: { threadId, anchorMessageId },
  });
  return response.deletedCount ?? 0;
}

/** Save a thread event on the server (fire-and-forget) */
export async function remoteSaveThreadEvent(
  threadId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!state.socket?.connected) return;
  state.socket.emit('data:save_thread_event', { payload: { threadId, eventType: type, data } });
}

/** Update tool call output on the server (fire-and-forget) */
export async function remoteUpdateToolCallOutput(
  toolCallId: string,
  output: string,
): Promise<void> {
  if (!state.socket?.connected) return;
  state.socket.emit('data:update_tool_call_output', { payload: { toolCallId, output } });
}

/**
 * In-flight + short-TTL cache for getThread to avoid hammering the server.
 * Multiple callers requesting the same thread within a short window share
 * a single WebSocket round-trip instead of each creating their own.
 */
const threadCache = new Map<string, { value: any; expiry: number }>();
const threadInflight = new Map<string, Promise<any>>();
const THREAD_CACHE_TTL = 3_000; // 3 seconds

/** Get a thread from the server by ID (deduplicated + cached) */
export async function remoteGetThread(threadId: string): Promise<any> {
  // Check TTL cache first
  const cached = threadCache.get(threadId);
  if (cached && Date.now() < cached.expiry) {
    return cached.value;
  }

  // Deduplicate in-flight requests
  const inflight = threadInflight.get(threadId);
  if (inflight) return inflight;

  const promise = sendDataMessage('data:get_thread', { threadId })
    .then((response) => {
      const thread = response?.thread ?? null;
      threadCache.set(threadId, { value: thread, expiry: Date.now() + THREAD_CACHE_TTL });
      return thread;
    })
    .finally(() => {
      threadInflight.delete(threadId);
    });

  threadInflight.set(threadId, promise);
  return promise;
}

/** Invalidate the thread cache (call after updates) */
export function invalidateThreadCache(threadId: string): void {
  threadCache.delete(threadId);
}

/**
 * Get a thread together with its full message history from the server.
 * Used by context recovery (post-merge, worktree-convert, model/provider
 * change) — without this the runner has no access to prior messages because
 * the central server owns the database.
 */
export async function remoteGetThreadWithMessages(
  threadId: string,
  messageLimit?: number,
): Promise<any> {
  const response = await sendDataMessage('data:get_thread_with_messages', {
    threadId,
    ...(messageLimit !== undefined ? { messageLimit } : {}),
  });
  return response?.thread ?? null;
}

/**
 * Get paginated messages for a thread from the server.
 * Mirrors `messageRepo.getThreadMessages({ threadId, cursor?, limit })`.
 * Returns oldest-first messages and a hasMore flag.
 */
export async function remoteGetThreadMessages(opts: {
  threadId: string;
  cursor?: string;
  limit: number;
}): Promise<{ messages: any[]; hasMore: boolean }> {
  const response = await sendDataMessage('data:get_thread_messages', {
    threadId: opts.threadId,
    limit: opts.limit,
    ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
  });
  return {
    messages: Array.isArray(response?.messages) ? response.messages : [],
    hasMore: !!response?.hasMore,
  };
}

/** Get an agent template from the server by ID */
export async function remoteGetAgentTemplate(templateId: string): Promise<any> {
  const response = await sendDataMessage('data:get_agent_template', { templateId });
  return response?.template ?? null;
}

/** Get a tool call from the server by ID */
export async function remoteGetToolCall(toolCallId: string): Promise<any> {
  const response = await sendDataMessage('data:get_tool_call', { toolCallId });
  return response?.toolCall ?? null;
}

/** Find a tool call on the server by messageId + name + input (dedup) */
export async function remoteFindToolCall(
  messageId: string,
  name: string,
  input: string,
): Promise<any> {
  const response = await sendDataMessage('data:find_tool_call', {
    payload: { messageId, name, input },
  });
  return response?.toolCall ?? null;
}

/** Find the last unanswered interactive tool call (ExitPlanMode / AskUserQuestion) for a thread */
export async function remoteFindLastUnansweredInteractiveToolCall(
  threadId: string,
): Promise<{ id: string; name: string } | undefined> {
  const response = await sendDataMessage('data:find_last_unanswered_interactive_tool_call', {
    threadId,
  });
  return response?.toolCall ?? undefined;
}

// ── Project operations ──────────────────────────────────

/**
 * In-flight + TTL cache for getProject.
 * Projects change very rarely, so a longer TTL (30s) is safe.
 */
const projectCache = new Map<string, { value: any; expiry: number }>();
const projectInflight = new Map<string, Promise<any>>();
const PROJECT_CACHE_TTL = 30_000; // 30 seconds

/** Get a project from the server by ID (deduplicated + cached) */
export async function remoteGetProject(projectId: string): Promise<any> {
  const cached = projectCache.get(projectId);
  if (cached && Date.now() < cached.expiry) {
    return cached.value;
  }

  const inflight = projectInflight.get(projectId);
  if (inflight) return inflight;

  const promise = sendDataMessage('data:get_project', { projectId })
    .then((response) => {
      const project = response?.project ?? null;
      projectCache.set(projectId, { value: project, expiry: Date.now() + PROJECT_CACHE_TTL });
      return project;
    })
    .finally(() => {
      projectInflight.delete(projectId);
    });

  projectInflight.set(projectId, promise);
  return promise;
}

/** Invalidate the project cache (call after updates) */
export function invalidateProjectCache(projectId: string): void {
  projectCache.delete(projectId);
}

/** List projects for a user on the server */
export async function remoteListProjects(userId: string): Promise<any[]> {
  const result = await sendDataMessage('data:list_projects', { userId });
  return result?.projects ?? result ?? [];
}

/** List all non-archived threads for a project (system call, no userId filter) */
export async function remoteListProjectThreads(projectId: string): Promise<any[]> {
  const result = await sendDataMessage('data:list_project_threads', { projectId });
  return result?.threads ?? [];
}

/** Resolve project path for a user on the server */
export async function remoteResolveProjectPath(
  projectId: string,
  userId: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  return sendDataMessage('data:resolve_project_path', { projectId, userId });
}

// ── Profile operations ──────────────────────────────────

/** Get a user profile from the server */
export async function remoteGetProfile(userId: string): Promise<any> {
  const response = await sendDataMessage('data:get_profile', { userId });
  return response?.profile ?? null;
}

/** Get a user's decrypted provider key from the server. */
export async function remoteGetProviderKey(
  userId: string,
  provider: string,
): Promise<string | null> {
  const result = await sendDataMessage('data:get_provider_key', { userId, provider });
  return result?.key ?? null;
}

/** Get a user's decrypted GitHub token from the server */
export async function remoteGetGithubToken(userId: string): Promise<string | null> {
  return remoteGetProviderKey(userId, 'github');
}

/** Get a user's decrypted MiniMax API key from the server */
export async function remoteGetMinimaxApiKey(userId: string): Promise<string | null> {
  return remoteGetProviderKey(userId, 'minimax');
}

/** Update a user profile on the server */
export async function remoteUpdateProfile(userId: string, data: Record<string, any>): Promise<any> {
  const response = await sendDataMessage('data:update_profile', { userId, payload: data });
  return response?.profile ?? null;
}

// ── Thread creation/deletion ────────────────────────────

/** Create a thread record on the server */
export async function remoteCreateThread(data: Record<string, any>): Promise<void> {
  await sendDataMessage('data:create_thread', { payload: data });
}

/** Delete a thread on the server */
export async function remoteDeleteThread(threadId: string): Promise<void> {
  await sendDataMessage('data:delete_thread', { threadId });
}

// ── Project creation ────────────────────────────────────

/** Create a project record on the server (used after cloning on the runner) */
export async function remoteCreateProject(
  name: string,
  path: string,
  userId: string,
): Promise<any> {
  const response = await sendDataMessage('data:create_project', {
    name,
    path,
    userId,
  });
  return response;
}

// ── Message queue ───────────────────────────────────────

/** Enqueue a message on the server */
export async function remoteEnqueueMessage(
  threadId: string,
  data: Record<string, any>,
): Promise<any> {
  return sendDataMessage('data:enqueue_message', { threadId, payload: data });
}

/** Dequeue the next message from the server's queue */
export async function remoteDequeueMessage(threadId: string): Promise<any | null> {
  const result = await sendDataMessage('data:dequeue_message', { threadId });
  return result?.dequeued ?? null;
}

/** Peek at the next message in the server's queue */
export async function remotePeekMessage(threadId: string): Promise<any | null> {
  const result = await sendDataMessage('data:peek_message', { threadId });
  return result?.peeked ?? null;
}

/** Get the count of queued messages from the server */
export async function remoteQueueCount(threadId: string): Promise<number> {
  const result = await sendDataMessage('data:queue_count', { threadId });
  return result?.count ?? 0;
}

/** List all queued messages for a thread */
export async function remoteListQueue(threadId: string): Promise<any[]> {
  const result = await sendDataMessage('data:list_queue', { threadId });
  return result?.items ?? [];
}

/** Cancel a queued message */
export async function remoteCancelQueuedMessage(messageId: string): Promise<boolean> {
  const result = await sendDataMessage('data:cancel_queued_message', { messageId });
  return result?.success ?? false;
}

/** Update a queued message */
export async function remoteUpdateQueuedMessage(
  messageId: string,
  content: string,
): Promise<any | null> {
  const result = await sendDataMessage('data:update_queued_message', { messageId, content });
  return result?.updated ?? null;
}

// ── Auto-resume ─────────────────────────────────────────

/**
 * Ask the server to mark stale running threads for this runner as interrupted
 * and return them. Used on startup to auto-resume threads that were interrupted
 * by a runtime crash.
 */
export async function remoteMarkAndListStaleThreads(): Promise<any[]> {
  const result = await sendDataMessage('data:mark_and_list_stale_threads', {});
  return result?.threads ?? [];
}

// ── Permission rules ────────────────────────────────────

/** Persist an "always allow" / "always deny" rule on the central server. */
export async function remoteCreatePermissionRule(input: {
  userId: string;
  projectPath: string;
  toolName: string;
  pattern: string | null;
  decision: 'allow' | 'deny';
}): Promise<any> {
  const response = await sendDataMessage('data:create_permission_rule', { payload: input });
  return response?.rule ?? null;
}

/** Look up a matching rule for a tool invocation on the central server. */
export async function remoteFindPermissionRule(query: {
  userId: string;
  projectPath: string;
  toolName: string;
  toolInput?: string;
}): Promise<any> {
  const response = await sendDataMessage('data:find_permission_rule', { payload: query });
  return response?.rule ?? null;
}

/** List all rules for a user, optionally scoped to a project path. */
export async function remoteListPermissionRules(query: {
  userId: string;
  projectPath?: string;
}): Promise<any[]> {
  const response = await sendDataMessage('data:list_permission_rules', { payload: query });
  return response?.rules ?? [];
}

// ── Lifecycle ────────────────────────────────────────────

/**
 * Initialize runner mode — connect to the central server.
 * Called from app.ts init() when TEAM_SERVER_URL is set.
 */
export async function initTeamMode(serverUrl: string): Promise<void> {
  state.serverUrl = serverUrl.replace(/\/$/, '');

  log.info(`Connecting to server at ${state.serverUrl}`, { namespace: 'runner' });

  // Subscribe to local wsBroker events early
  state.unsubscribeBroker = wsBroker.onEvent(forwardEventToCentral);

  // Register as a runner (with retries if the server is not yet available)
  const registered = await registerWithRetry();
  if (!registered) {
    log.error('Failed to register with central server after retries — runner mode disabled', {
      namespace: 'runner',
    });
    return;
  }

  // Start heartbeat (every 15s)
  state.heartbeatTimer = setInterval(sendHeartbeat, 15_000);
  if (state.heartbeatTimer.unref) state.heartbeatTimer.unref();

  // Start task polling (every 5s)
  state.pollTimer = setInterval(pollTasks, 5_000);
  if (state.pollTimer.unref) state.pollTimer.unref();

  // Connect Socket.IO (handles reconnection, heartbeat, transport fallback)
  connectSocket();

  // In WS-only mode, defer project assignment until WS is authenticated.
  // The WS onopen handler sends runner:auth, and after auth_ok we assign projects.
  if (!WS_ONLY) {
    await assignLocalProjects();
  }

  log.info('Runner mode initialized', {
    namespace: 'runner',
    runnerId: state.runnerId,
    transport: WS_ONLY ? 'ws-only' : 'http+ws',
  });
}

/**
 * Shutdown runner mode — clean up connections and timers.
 */
export function shutdownTeamMode(): void {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.unsubscribeBroker) state.unsubscribeBroker();

  // Disconnect Socket.IO (handles cleanup automatically)
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }

  state.heartbeatTimer = null;
  state.pollTimer = null;
  state.unsubscribeBroker = null;
  state.runnerId = null;
  state.runnerToken = null;

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
