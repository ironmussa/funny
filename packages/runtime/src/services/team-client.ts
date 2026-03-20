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
import type {
  DataInsertMessage,
  DataInsertToolCall,
  RunnerRegisterResponse,
  RunnerTask,
} from '@funny/shared/runner-protocol';
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
    }
  } catch (err) {
    log.warn('Heartbeat failed', { namespace: 'runner', error: err as any });
  }
}

// ── WS-only Heartbeat ────────────────────────────────────

async function sendHeartbeatWS(): Promise<void> {
  try {
    const response = await sendDataMessage('runner:heartbeat', {
      activeThreadIds: [],
    });

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
    log.warn('WS heartbeat failed', { namespace: 'runner', error: (err as Error).message });
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

// ── Project Assignment ───────────────────────────────────

async function assignLocalProjects(): Promise<void> {
  if (!state.runnerId) return;

  try {
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

  // Handle tunnel requests with ack callback
  socket.on('tunnel:request', async (data: any, ack: (response: any) => void) => {
    const response = await handleTunnelRequest(data);
    ack(response);
  });

  // Handle browser WS messages forwarded through the central server
  socket.on('central:browser_ws', (data: any) => {
    if (data.userId && data.data) {
      handleBrowserWSMessage(data.userId, data.data);
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
    log.warn('No browser WS handler registered', { namespace: 'runner' });
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
 * Send a data message to the server using Socket.IO emit + ack.
 * Socket.IO's acknowledgement callback handles request/response correlation.
 */
async function sendDataMessage(eventType: string, payload: Record<string, any>): Promise<any> {
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

  return new Promise((resolve, reject) => {
    state
      .socket!.timeout(DATA_REQUEST_TIMEOUT)
      .emit(eventType, payload, (err: Error | null, response: any) => {
        if (err) {
          reject(new Error(`Data request timed out (${eventType})`));
        } else if (response?.success === false && response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
  });
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
  await sendDataMessage('data:update_thread', { payload: { threadId, updates } });
}

/** Update message content on the server (fire-and-forget) */
export async function remoteUpdateMessage(messageId: string, content: string): Promise<void> {
  if (!state.socket?.connected) return;
  state.socket.emit('data:update_message', { payload: { messageId, content } });
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

/** Get a thread from the server by ID */
export async function remoteGetThread(threadId: string): Promise<any> {
  const response = await sendDataMessage('data:get_thread', { threadId });
  return response?.thread ?? null;
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

// ── Project operations ──────────────────────────────────

/** Get a project from the server by ID */
export async function remoteGetProject(projectId: string): Promise<any> {
  const response = await sendDataMessage('data:get_project', { projectId });
  return response?.project ?? null;
}

/** Get an arc from the server by ID */
export async function remoteGetArc(arcId: string): Promise<any> {
  const response = await sendDataMessage('data:get_arc', { arcId });
  return response?.arc ?? null;
}

/** List projects for a user on the server */
export async function remoteListProjects(userId: string): Promise<any[]> {
  const result = await sendDataMessage('data:list_projects', { userId });
  return result?.projects ?? result ?? [];
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

/** Get a user's decrypted GitHub token from the server */
export async function remoteGetGithubToken(userId: string): Promise<string | null> {
  const result = await sendDataMessage('data:get_github_token', { userId });
  return result?.token ?? null;
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
