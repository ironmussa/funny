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
 * Responsibilities:
 * - Authenticate with the central server
 * - Register as a runner
 * - Heartbeat (every 15s)
 * - Poll for pending tasks (every 5s)
 * - Assign local projects to the server (on startup + when created)
 * - Connect WebSocket for agent event streaming and tunneled HTTP requests
 */

import { hostname } from 'os';

import type { Project, WSEvent } from '@funny/shared';
import type {
  CentralWSTunnelRequest,
  DataInsertMessage,
  DataInsertToolCall,
  RunnerRegisterResponse,
  RunnerTask,
} from '@funny/shared/runner-protocol';
import { nanoid } from 'nanoid';

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

/** WebSocket reconnection with exponential backoff */
const WS_RECONNECT = {
  BASE_DELAY_MS: 1_000,
  MAX_DELAY_MS: 30_000,
  BACKOFF_FACTOR: 2,
  /** How often we send a protocol-level ping (ms) */
  PING_INTERVAL_MS: 10_000,
  /** If no pong arrives within this window, consider the connection dead (ms) */
  PONG_TIMEOUT_MS: 5_000,
} as const;

interface TeamClientState {
  serverUrl: string;
  runnerId: string | null;
  runnerToken: string | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  wsPingTimer: ReturnType<typeof setInterval> | null;
  wsPongTimeout: ReturnType<typeof setTimeout> | null;
  wsReconnectAttempt: number;
  ws: WebSocket | null;
  unsubscribeBroker: (() => void) | null;
  browserWSHandler: BrowserWSHandler | null;
  /** Reference to the local Hono app for handling tunnel requests */
  localApp: FetchableApp | null;
  /** Pending data requests awaiting server responses, keyed by requestId */
  pendingDataRequests: Map<string, { resolve: (value: any) => void; reject: (err: Error) => void }>;
  /** Whether the tunnel poll loop is running */
  tunnelPollRunning: boolean;
  /** Set of requestIds already processed, for dedup between WS push and HTTP poll */
  processedRequestIds: Set<string>;
}

const state: TeamClientState = {
  serverUrl: '',
  runnerId: null,
  runnerToken: null,
  heartbeatTimer: null,
  pollTimer: null,
  wsPingTimer: null,
  wsPongTimeout: null,
  wsReconnectAttempt: 0,
  ws: null,
  unsubscribeBroker: null,
  browserWSHandler: null,
  localApp: null,
  pendingDataRequests: new Map(),
  tunnelPollRunning: false,
  processedRequestIds: new Set(),
};

// ── Deduplication ─────────────────────────────────────────
// Requests may arrive via both WS push and HTTP poll. Track processed IDs
// to avoid handling the same request twice.

const DEDUP_TTL_MS = 60_000;
const dedupTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Returns true if this is the first time seeing this requestId. */
function markProcessed(requestId: string): boolean {
  if (state.processedRequestIds.has(requestId)) return false;
  state.processedRequestIds.add(requestId);
  const timer = setTimeout(() => {
    state.processedRequestIds.delete(requestId);
    dedupTimers.delete(requestId);
  }, DEDUP_TTL_MS);
  if (timer.unref) timer.unref();
  dedupTimers.set(requestId, timer);
  return true;
}

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

    // When using a user invite token (RUNNER_INVITE_TOKEN), send it as a header
    // so the server can associate this runner with the user's account.
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

    log.info('Registered with central server', {
      namespace: 'runner',
      runnerId: data.runnerId,
      transport: httpUrl ? 'http+tunnel' : 'tunnel-only',
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

    const delay = Math.min(2000 * attempt, 15_000); // 2s, 4s, 6s, ... cap at 15s
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
        // Re-establish WS connection with new token
        if (state.ws) {
          try {
            state.ws.close();
          } catch {}
        }
        connectWebSocket();
        // Re-assign projects
        await assignLocalProjects();
        log.info('Runner re-registered after server restart', {
          namespace: 'runner',
          runnerId: state.runnerId,
        });
      }
    }
    // WS health check — reconnect if WS is locally dead OR the server says it's not connected.
    // The server includes `wsConnected` in the heartbeat response so the runner can detect
    // stale connections (e.g. after server restart where the TCP close was never delivered).
    if (res.ok) {
      let serverSaysDisconnected = false;
      try {
        const hbData = await res.clone().json();
        serverSaysDisconnected = hbData.wsConnected === false;
      } catch {}

      const locallyDead = !state.ws || state.ws.readyState !== WebSocket.OPEN;

      if (locallyDead || serverSaysDisconnected) {
        log.warn('WS tunnel stale — reconnecting', {
          namespace: 'runner',
          locallyDead,
          serverSaysDisconnected,
          wsState: state.ws?.readyState ?? 'null',
        });
        if (state.ws) {
          try {
            state.ws.close();
          } catch {}
          state.ws = null;
        }
        clearWsTimers();
        state.wsReconnectAttempt = 0;
        connectWebSocket();
      }
    }
  } catch (err) {
    log.warn('Heartbeat failed', { namespace: 'runner', error: err as any });
  }
}

// ── WS-only Heartbeat ────────────────────────────────────

async function sendHeartbeatWS(): Promise<void> {
  try {
    const response = await sendDataMessage({
      type: 'runner:heartbeat',
      requestId: nanoid(),
      payload: { activeThreadIds: [] },
    });

    // WS health check — if the server says our WS is not connected,
    // something is wrong (should not happen in WS-only mode, but be safe)
    if (response?.wsConnected === false) {
      log.warn('Server reports WS not connected despite WS heartbeat — reconnecting', {
        namespace: 'runner',
      });
      if (state.ws) {
        try {
          state.ws.close();
        } catch {}
        state.ws = null;
      }
      clearWsTimers();
      state.wsReconnectAttempt = 0;
      connectWebSocket();
    }

    // Handle re-registration if runner not found
    if (response?.code === 'RUNNER_NOT_FOUND') {
      log.warn('Runner not found on server — re-registering', { namespace: 'runner' });
      state.runnerId = null;
      state.runnerToken = null;
      const ok = await register();
      if (ok) {
        if (state.ws) {
          try {
            state.ws.close();
          } catch {}
        }
        connectWebSocket();
        await assignLocalProjects();
      }
    }
  } catch (err) {
    log.warn('WS heartbeat failed', { namespace: 'runner', error: (err as Error).message });
  }
}

// ── WS-only Task Polling ─────────────────────────────────

async function pollTasksWS(): Promise<void> {
  try {
    const response = await sendDataMessage({
      type: 'runner:poll_tasks',
      requestId: nanoid(),
    });

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
    // Silent — WS may be temporarily disconnected
  }
}

// ── WS-only Project Assignment ───────────────────────────

async function assignProjectWS(projectId: string, localPath: string): Promise<void> {
  if (!state.runnerId) return;
  try {
    await sendDataMessage({
      type: 'runner:assign_project',
      requestId: nanoid(),
      runnerId: state.runnerId,
      payload: { projectId, localPath },
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
    const projects = await getServices().projects.listProjects('__local__');

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
 * Called when a new project is created on the Runtime.
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
    log.info('Assigned new project to runner', {
      namespace: 'runner',
      projectId: project.id,
    });
  } catch {
    // Non-fatal
  }
}

// ── WebSocket Connection ─────────────────────────────────

/** Clear all keepalive timers */
function clearWsTimers(): void {
  if (state.wsPingTimer) {
    clearInterval(state.wsPingTimer);
    state.wsPingTimer = null;
  }
  if (state.wsPongTimeout) {
    clearTimeout(state.wsPongTimeout);
    state.wsPongTimeout = null;
  }
}

/** Schedule a reconnect with exponential backoff */
function scheduleReconnect(): void {
  const delay = Math.min(
    WS_RECONNECT.BASE_DELAY_MS * Math.pow(WS_RECONNECT.BACKOFF_FACTOR, state.wsReconnectAttempt),
    WS_RECONNECT.MAX_DELAY_MS,
  );
  state.wsReconnectAttempt++;
  log.warn(
    `WebSocket disconnected from central, reconnecting in ${(delay / 1000).toFixed(1)}s...`,
    {
      namespace: 'runner',
      attempt: state.wsReconnectAttempt,
    },
  );
  setTimeout(connectWebSocket, delay);
}

/** Send a ping and arm a pong timeout — if no pong arrives, force-close */
function sendWsPing(ws: WebSocket): void {
  if (ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({ type: 'runner:ping' }));

  // Arm a pong timeout — if the server doesn't respond, the connection is dead
  if (state.wsPongTimeout) clearTimeout(state.wsPongTimeout);
  state.wsPongTimeout = setTimeout(() => {
    log.warn('WebSocket pong timeout — closing stale connection', { namespace: 'runner' });
    try {
      ws.close(4000, 'Pong timeout');
    } catch {}
  }, WS_RECONNECT.PONG_TIMEOUT_MS);
}

function connectWebSocket(): void {
  const wsUrl = state.serverUrl.replace(/^http/, 'ws') + '/ws/runner';

  log.info('Attempting WebSocket connection', { namespace: 'runner', url: wsUrl });

  try {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // Authenticate
      ws.send(JSON.stringify({ type: 'runner:auth', token: state.runnerToken }));
      log.info('WebSocket connected to central', { namespace: 'runner' });

      // Reset backoff on successful connection
      state.wsReconnectAttempt = 0;

      // Start periodic ping keepalive
      clearWsTimers();
      state.wsPingTimer = setInterval(() => sendWsPing(ws), WS_RECONNECT.PING_INTERVAL_MS);
      if (state.wsPingTimer.unref) state.wsPingTimer.unref();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);

        // Any message from the server proves liveness — clear pong timeout
        if (state.wsPongTimeout) {
          clearTimeout(state.wsPongTimeout);
          state.wsPongTimeout = null;
        }

        if (data.type === 'runner:auth_ok') {
          log.info('WebSocket authenticated', { namespace: 'runner' });

          // In WS-only mode, assign projects now that WS is ready
          if (WS_ONLY) {
            assignLocalProjects().catch(() => {});
          }
        }

        // Pong response — already handled above (timeout cleared)
        if (data.type === 'runner:pong') return;

        // Handle browser WS messages forwarded through the central server
        if (data.type === 'central:browser_ws' && data.userId && data.data) {
          handleBrowserWSMessage(data.userId, data.data);
        }

        // Handle task commands from central
        if (data.type === 'central:command' && data.task) {
          log.info('Received command from central', {
            namespace: 'runner',
            taskId: data.task.taskId,
            type: data.task.type,
          });
          // TODO: Execute task locally and report result
        }

        // Handle tunneled HTTP requests from the server
        if (data.type === 'tunnel:request') {
          handleTunnelRequest(data as CentralWSTunnelRequest);
        }

        // Handle data persistence and runner operation responses from the server
        if (
          data.requestId &&
          (data.type?.startsWith('data:') || data.type?.startsWith('runner:'))
        ) {
          handleDataResponse(data);
        }
      } catch {}
    };

    ws.onclose = (event) => {
      log.warn('WebSocket closed', {
        namespace: 'runner',
        code: event.code,
        reason: event.reason || 'none',
        wasClean: event.wasClean,
      });

      state.ws = null;
      clearWsTimers();

      // Immediately reject all pending data requests — the WS is gone,
      // no point waiting for the 15s timeout to fire as unhandled rejections.
      for (const [id, pending] of state.pendingDataRequests) {
        state.pendingDataRequests.delete(id);
        pending.reject(new Error('WebSocket disconnected before response'));
      }

      scheduleReconnect();
    };

    ws.onerror = (event) => {
      log.error('WebSocket connection error', {
        namespace: 'runner',
        url: wsUrl,
        message: (event as any)?.message || 'unknown',
      });
      // onclose will fire after onerror
    };

    state.ws = ws;
  } catch (err) {
    log.error('Failed to connect WebSocket to central', { namespace: 'runner', error: err as any });
    scheduleReconnect();
  }
}

// ── Browser WS Message Handling ─────────────────────────

/**
 * Handle a browser WS message forwarded through the central server.
 * Delegates to the registered handler (set by runtime's index.ts).
 */
function handleBrowserWSMessage(userId: string, data: unknown): void {
  if (!state.browserWSHandler) {
    log.warn('No browser WS handler registered', { namespace: 'runner' });
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
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    log.warn('Cannot forward event — WS not connected to central', {
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

// ── Tunnel Request Handling ──────────────────────────────

/**
 * Handle a tunneled HTTP request from the server.
 * Forwards the request to the local Hono app and sends the response back.
 */
async function handleTunnelRequest(data: CentralWSTunnelRequest): Promise<void> {
  // Dedup: skip if already handled via the other channel (WS push or HTTP poll)
  if (!markProcessed(data.requestId)) return;

  if (!state.localApp) {
    log.warn('Received tunnel:request but no local app registered', { namespace: 'runner' });
    sendTunnelResponse(data.requestId, 503, {}, 'Local app not initialized');
    return;
  }

  try {
    // Build a Request object for the local Hono app
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

    // Serialize the response
    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    sendTunnelResponse(data.requestId, response.status, responseHeaders, responseBody);
  } catch (err) {
    log.error('Failed to handle tunnel request', {
      namespace: 'runner',
      requestId: data.requestId,
      path: data.path,
      error: (err as Error).message,
    });
    sendTunnelResponse(data.requestId, 500, {}, JSON.stringify({ error: 'Internal runner error' }));
  }
}

function sendTunnelResponse(
  requestId: string,
  status: number,
  headers: Record<string, string>,
  body: string | null,
): void {
  // Try WS first (lower latency)
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try {
      state.ws.send(
        JSON.stringify({
          type: 'tunnel:response',
          requestId,
          status,
          headers,
          body,
        }),
      );
      return; // WS send succeeded
    } catch {
      // WS send failed — fall through to HTTP
    }
  }

  // Fallback: send result via HTTP POST (skip in WS-only mode)
  if (!WS_ONLY) {
    sendTunnelResponseHttp(requestId, status, headers, body).catch(() => {});
  }
}

/** Send tunnel result via HTTP when WS is unavailable */
async function sendTunnelResponseHttp(
  requestId: string,
  status: number,
  headers: Record<string, string>,
  body: string | null,
): Promise<void> {
  try {
    const res = await centralFetch('/api/runners/tunnel/result', {
      method: 'POST',
      body: JSON.stringify({ requestId, status, headers, body }),
    });
    if (!res.ok) {
      log.warn('HTTP tunnel result rejected', {
        namespace: 'runner',
        requestId,
        status: res.status,
      });
    }
  } catch (err) {
    log.warn('Failed to send tunnel result via HTTP', {
      namespace: 'runner',
      requestId,
      error: (err as Error).message,
    });
  }
}

// ── HTTP Tunnel Poll Loop ────────────────────────────────

/**
 * Long-poll loop that pulls queued tunnel requests from the server.
 * This is the reliable baseline transport — runs continuously alongside WS.
 * Requests may also arrive via WS push (deduped by requestId).
 */
async function tunnelPollLoop(): Promise<void> {
  if (state.tunnelPollRunning) return;
  state.tunnelPollRunning = true;

  log.info('Tunnel poll loop started', { namespace: 'runner' });

  while (state.tunnelPollRunning && state.runnerId) {
    try {
      const res = await centralFetch('/api/runners/tunnel/poll');
      if (!res.ok) {
        // Server error — back off briefly
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }

      const { requests } = (await res.json()) as {
        requests: Array<{
          requestId: string;
          method: string;
          path: string;
          headers: Record<string, string>;
          body: string | null;
        }>;
      };

      for (const req of requests) {
        // handleTunnelRequest dedupes internally via markProcessed()
        handleTunnelRequest({
          type: 'tunnel:request',
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          headers: req.headers,
          body: req.body,
        });
      }
    } catch {
      // Network error — back off before retrying
      if (state.tunnelPollRunning) {
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }

  log.info('Tunnel poll loop stopped', { namespace: 'runner' });
}

// ── Data Persistence (Runner → Server) ──────────────────

/** Timeout for data requests awaiting server response (ms) */
const DATA_REQUEST_TIMEOUT = 15_000;

/**
 * Handle a data response from the server.
 * Resolves the pending promise for the matching requestId.
 */
function handleDataResponse(data: any): void {
  const pending = state.pendingDataRequests.get(data.requestId);
  if (!pending) return;

  state.pendingDataRequests.delete(data.requestId);

  switch (data.type) {
    case 'data:insert_message_response':
      pending.resolve({ messageId: data.messageId });
      break;
    case 'data:insert_tool_call_response':
      pending.resolve({ toolCallId: data.toolCallId });
      break;
    case 'data:ack':
      if (data.success) {
        pending.resolve({ success: true });
      } else {
        pending.reject(new Error(data.error ?? 'Server returned error'));
      }
      break;
    case 'data:update_thread_response':
      pending.resolve({ ok: true });
      break;
    case 'data:get_thread_response':
      pending.resolve(data.thread);
      break;
    case 'data:get_tool_call_response':
      pending.resolve(data.toolCall);
      break;
    case 'data:find_tool_call_response':
      pending.resolve(data.toolCall);
      break;
    case 'data:get_project_response':
      pending.resolve(data.project);
      break;
    case 'data:list_projects_response':
      pending.resolve(data.projects);
      break;
    case 'data:resolve_project_path_response':
      pending.resolve({ ok: data.ok, path: data.path, error: data.error });
      break;
    case 'data:enqueue_message_response':
      pending.resolve(data.queued);
      break;
    case 'data:get_arc_response':
      pending.resolve(data.arc);
      break;
    case 'data:get_profile_response':
      pending.resolve(data.profile);
      break;
    case 'data:get_github_token_response':
      pending.resolve({ token: data.token });
      break;
    case 'data:update_profile_response':
      pending.resolve(data.profile);
      break;
    default:
      pending.resolve(data);
  }
}

/** Max retries when the WS is temporarily disconnected */
const SEND_RETRY_MAX = 3;
/** Delay between retries (ms) — should be enough for a reconnect cycle */
const SEND_RETRY_DELAY_MS = 2_000;

/**
 * Send a data message to the server and wait for a response.
 * Creates a pending promise keyed by requestId that is resolved
 * when the server sends the corresponding response.
 *
 * If the WebSocket is temporarily disconnected, retries up to
 * SEND_RETRY_MAX times with a delay, giving the reconnect logic
 * time to re-establish the connection.
 */
async function sendDataMessage(message: Record<string, any>, attempt = 0): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      if (attempt < SEND_RETRY_MAX) {
        // Wait for the WS to reconnect and retry
        log.debug(
          `sendDataMessage: WS not connected, retrying in ${SEND_RETRY_DELAY_MS}ms (attempt ${attempt + 1}/${SEND_RETRY_MAX})`,
          {
            namespace: 'runner',
            messageType: message.type,
          },
        );
        setTimeout(() => {
          sendDataMessage(message, attempt + 1).then(resolve, reject);
        }, SEND_RETRY_DELAY_MS);
        return;
      }
      reject(new Error('WebSocket not connected to central server'));
      return;
    }

    const requestId = message.requestId as string;
    if (!requestId) {
      reject(new Error('Data message must have a requestId'));
      return;
    }

    // Set up timeout
    const timer = setTimeout(() => {
      state.pendingDataRequests.delete(requestId);
      reject(new Error(`Data request timed out after ${DATA_REQUEST_TIMEOUT}ms (${message.type})`));
    }, DATA_REQUEST_TIMEOUT);

    state.pendingDataRequests.set(requestId, {
      resolve: (value: any) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    try {
      state.ws.send(JSON.stringify(message));
    } catch (err) {
      clearTimeout(timer);
      state.pendingDataRequests.delete(requestId);
      reject(err);
    }
  });
}

/** Insert a message on the server, returns the server-generated messageId */
export async function remoteInsertMessage(data: DataInsertMessage['payload']): Promise<string> {
  const requestId = nanoid();
  const response = await sendDataMessage({
    type: 'data:insert_message',
    requestId,
    payload: data,
  });
  return response.messageId;
}

/** Insert a tool call on the server, returns the server-generated toolCallId */
export async function remoteInsertToolCall(data: DataInsertToolCall['payload']): Promise<string> {
  const requestId = nanoid();
  const response = await sendDataMessage({
    type: 'data:insert_tool_call',
    requestId,
    payload: data,
  });
  return response.toolCallId;
}

/** Update thread fields on the server (request-response, awaits confirmation) */
export async function remoteUpdateThread(
  threadId: string,
  updates: Record<string, any>,
): Promise<void> {
  const requestId = nanoid();
  await sendDataMessage({
    type: 'data:update_thread',
    requestId,
    payload: { threadId, updates },
  });
}

/** Update message content on the server (fire-and-forget) */
export async function remoteUpdateMessage(messageId: string, content: string): Promise<void> {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  try {
    state.ws.send(
      JSON.stringify({
        type: 'data:update_message',
        payload: { messageId, content },
      }),
    );
  } catch {}
}

/** Save a thread event on the server (fire-and-forget) */
export async function remoteSaveThreadEvent(
  threadId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  try {
    state.ws.send(
      JSON.stringify({
        type: 'data:save_thread_event',
        payload: { threadId, eventType: type, data },
      }),
    );
  } catch {}
}

/** Update tool call output on the server (fire-and-forget) */
export async function remoteUpdateToolCallOutput(
  toolCallId: string,
  output: string,
): Promise<void> {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  try {
    state.ws.send(
      JSON.stringify({
        type: 'data:update_tool_call_output',
        payload: { toolCallId, output },
      }),
    );
  } catch {}
}

/** Get a thread from the server by ID */
export async function remoteGetThread(threadId: string): Promise<any> {
  const requestId = nanoid();
  return sendDataMessage({
    type: 'data:get_thread',
    requestId,
    threadId,
  });
}

/** Get a tool call from the server by ID */
export async function remoteGetToolCall(toolCallId: string): Promise<any> {
  const requestId = nanoid();
  return sendDataMessage({
    type: 'data:get_tool_call',
    requestId,
    toolCallId,
  });
}

/** Find a tool call on the server by messageId + name + input (dedup) */
export async function remoteFindToolCall(
  messageId: string,
  name: string,
  input: string,
): Promise<any> {
  const requestId = nanoid();
  return sendDataMessage({
    type: 'data:find_tool_call',
    requestId,
    payload: { messageId, name, input },
  });
}

// ── Project operations ──────────────────────────────────

/** Get a project from the server by ID */
export async function remoteGetProject(projectId: string): Promise<any> {
  const requestId = nanoid();
  return sendDataMessage({
    type: 'data:get_project',
    requestId,
    projectId,
  });
}

/** Get an arc from the server by ID */
export async function remoteGetArc(arcId: string): Promise<any> {
  const requestId = nanoid();
  return sendDataMessage({
    type: 'data:get_arc',
    requestId,
    arcId,
  });
}

/** List projects for a user on the server */
export async function remoteListProjects(userId: string): Promise<any[]> {
  const requestId = nanoid();
  const result = await sendDataMessage({
    type: 'data:list_projects',
    requestId,
    userId,
  });
  return result ?? [];
}

/** Resolve project path for a user on the server */
export async function remoteResolveProjectPath(
  projectId: string,
  userId: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const requestId = nanoid();
  return sendDataMessage({
    type: 'data:resolve_project_path',
    requestId,
    projectId,
    userId,
  });
}

// ── Profile operations ──────────────────────────────────

/** Get a user profile from the server */
export async function remoteGetProfile(userId: string): Promise<any> {
  const requestId = nanoid();
  return sendDataMessage({
    type: 'data:get_profile',
    requestId,
    userId,
  });
}

/** Get a user's decrypted GitHub token from the server */
export async function remoteGetGithubToken(userId: string): Promise<string | null> {
  const requestId = nanoid();
  const result = await sendDataMessage({
    type: 'data:get_github_token',
    requestId,
    userId,
  });
  return result?.token ?? null;
}

/** Update a user profile on the server */
export async function remoteUpdateProfile(userId: string, data: Record<string, any>): Promise<any> {
  const requestId = nanoid();
  return sendDataMessage({
    type: 'data:update_profile',
    requestId,
    userId,
    payload: data,
  });
}

// ── Thread creation/deletion ────────────────────────────

/** Create a thread record on the server */
export async function remoteCreateThread(data: Record<string, any>): Promise<void> {
  const requestId = nanoid();
  await sendDataMessage({
    type: 'data:create_thread',
    requestId,
    payload: data,
  });
}

/** Delete a thread on the server */
export async function remoteDeleteThread(threadId: string): Promise<void> {
  const requestId = nanoid();
  await sendDataMessage({
    type: 'data:delete_thread',
    requestId,
    threadId,
  });
}

// ── Message queue ───────────────────────────────────────

/** Enqueue a message on the server */
export async function remoteEnqueueMessage(
  threadId: string,
  data: Record<string, any>,
): Promise<any> {
  const requestId = nanoid();
  return sendDataMessage({
    type: 'data:enqueue_message',
    requestId,
    threadId,
    payload: data,
  });
}

// ── Lifecycle ────────────────────────────────────────────

/**
 * Initialize runner mode — connect to the central server.
 * Called from app.ts init() when TEAM_SERVER_URL is set,
 * configuring this runtime as a runner for the server.
 */
export async function initTeamMode(serverUrl: string): Promise<void> {
  state.serverUrl = serverUrl.replace(/\/$/, ''); // Remove trailing slash

  log.info(`Connecting to server at ${state.serverUrl}`, { namespace: 'runner' });

  // Subscribe to local wsBroker events early — even before registration succeeds,
  // so events are forwarded as soon as the WS connection is established.
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

  // Connect WebSocket for event streaming
  connectWebSocket();

  // Start HTTP tunnel poll loop (reliable baseline transport) — skip in WS-only mode
  if (!WS_ONLY) {
    tunnelPollLoop();
  }

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
  if (state.ws) state.ws.close();

  // Stop tunnel poll loop
  state.tunnelPollRunning = false;

  // Clean up dedup state
  state.processedRequestIds.clear();
  for (const [, timer] of dedupTimers) clearTimeout(timer);
  dedupTimers.clear();

  state.heartbeatTimer = null;
  state.pollTimer = null;
  state.unsubscribeBroker = null;
  state.ws = null;
  state.runnerId = null;
  state.runnerToken = null;

  // Reject any pending data requests
  for (const [, pending] of state.pendingDataRequests) {
    pending.reject(new Error('Runner mode shutting down'));
  }
  state.pendingDataRequests.clear();

  log.info('Runner mode shutdown', { namespace: 'runner' });
}

/** Get the central server URL (or null if not connected) */
export function getTeamServerUrl(): string | null {
  return state.serverUrl || null;
}

/**
 * Register a handler for browser WS messages forwarded through the server.
 * Called by runtime's app.ts to handle PTY commands, etc.
 */
export function setBrowserWSHandler(handler: BrowserWSHandler): void {
  state.browserWSHandler = handler;
}

/**
 * Register the local Hono app for handling tunneled HTTP requests from the server.
 * Called by runtime's app.ts after creating the app, so tunnel:request
 * messages can be forwarded to the app's routes.
 */
export function setLocalApp(app: FetchableApp): void {
  state.localApp = app;
}
