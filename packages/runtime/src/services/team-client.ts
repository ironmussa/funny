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
import { listProjects } from './project-manager.js';
import { wsBroker } from './ws-broker.js';

export type BrowserWSHandler = (
  userId: string,
  data: unknown,
  respond: (responseData: unknown) => void,
) => void;

/** A Hono-like app that can handle fetch requests */
type FetchableApp = { fetch: (request: Request) => Promise<Response> | Response };

interface TeamClientState {
  serverUrl: string;
  runnerId: string | null;
  runnerToken: string | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  ws: WebSocket | null;
  unsubscribeBroker: (() => void) | null;
  browserWSHandler: BrowserWSHandler | null;
  /** Reference to the local Hono app for handling tunnel requests */
  localApp: FetchableApp | null;
  /** Pending data requests awaiting server responses, keyed by requestId */
  pendingDataRequests: Map<string, { resolve: (value: any) => void; reject: (err: Error) => void }>;
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
  localApp: null,
  pendingDataRequests: new Map(),
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
    // Only set httpUrl if explicitly configured (allows direct HTTP fallback).
    // Without it, all communication goes through the WebSocket tunnel (works behind NAT).
    const httpUrl = process.env.RUNNER_HTTP_URL || undefined;

    const res = await centralFetch('/api/runners/register', {
      method: 'POST',
      body: JSON.stringify({
        name: `${hostname()}-funny`,
        hostname: hostname(),
        os: process.platform,
        ...(httpUrl ? { httpUrl } : {}),
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
 * The central server may not be ready when the runtime starts.
 */
async function registerWithRetry(maxAttempts = 10): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ok = await register();
    if (ok) return true;

    if (attempt < maxAttempts) {
      const delay = Math.min(2000 * attempt, 15_000); // 2s, 4s, 6s, ... up to 15s
      log.warn(
        `Registration failed, retrying in ${delay / 1000}s (attempt ${attempt}/${maxAttempts})`,
        {
          namespace: 'runner',
        },
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return false;
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
    log.warn('Heartbeat failed', { namespace: 'runner', error: err as any });
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
    await centralFetch(`/api/runners/${state.runnerId}/projects`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: project.id,
        localPath: project.path,
      }),
    });
    log.info('Assigned new project to runner', {
      namespace: 'runner',
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
      log.info('WebSocket connected to central', { namespace: 'runner' });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === 'runner:auth_ok') {
          log.info('WebSocket authenticated', { namespace: 'runner' });
        }

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

        // Handle data persistence responses from the server
        if (data.type?.startsWith('data:') && data.requestId) {
          handleDataResponse(data);
        }
      } catch {}
    };

    ws.onclose = () => {
      log.warn('WebSocket disconnected from central, reconnecting in 5s...', {
        namespace: 'runner',
      });
      state.ws = null;
      setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };

    state.ws = ws;
  } catch (err) {
    log.error('Failed to connect WebSocket to central', { namespace: 'runner', error: err as any });
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
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
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
  } catch {
    // WS may have closed
  }
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
    case 'data:get_thread_response':
      pending.resolve(data.thread);
      break;
    case 'data:get_tool_call_response':
      pending.resolve(data.toolCall);
      break;
    case 'data:find_tool_call_response':
      pending.resolve(data.toolCall);
      break;
    default:
      pending.resolve(data);
  }
}

/**
 * Send a data message to the server and wait for a response.
 * Creates a pending promise keyed by requestId that is resolved
 * when the server sends the corresponding response.
 */
function sendDataMessage(message: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
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

/** Update thread fields on the server (fire-and-forget) */
export async function remoteUpdateThread(
  threadId: string,
  updates: Record<string, any>,
): Promise<void> {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  try {
    state.ws.send(
      JSON.stringify({
        type: 'data:update_thread',
        payload: { threadId, updates },
      }),
    );
  } catch {}
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

  // Assign local projects to this runner on the server
  await assignLocalProjects();

  log.info('Runner mode initialized', { namespace: 'runner', runnerId: state.runnerId });
}

/**
 * Shutdown runner mode — clean up connections and timers.
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

  // Reject any pending data requests
  for (const [, pending] of state.pendingDataRequests) {
    pending.reject(new Error('Runner mode shutting down'));
  }
  state.pendingDataRequests.clear();

  log.info('Runner mode shutdown', { namespace: 'runner' });
}

/** Check if the runner is connected to a server */
export function isTeamModeActive(): boolean {
  return !!state.runnerId;
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
