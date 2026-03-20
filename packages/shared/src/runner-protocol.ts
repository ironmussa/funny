/**
 * Runner ↔ Central Server Protocol Types
 *
 * Defines the contract between local runners and the central funny server.
 * Communication uses Socket.IO for real-time events, tunnel requests,
 * and data persistence. HTTP is used for registration and heartbeat fallback.
 *
 * Key design: Runners are project-agnostic. They register as available machines.
 * The central server assigns projects to runners via the admin UI/API.
 * The runner receives tasks with a `cwd` and executes them — it never needs
 * to know about projects upfront.
 */

import type { AgentModel, AgentProvider, PermissionMode, WSEvent } from './types.js';

// ─── Runner Identity ────────────────────────────────────

export type RunnerStatus = 'online' | 'busy' | 'offline';

export interface RunnerInfo {
  runnerId: string;
  name: string;
  hostname: string;
  os: string;
  /** Optional base directory where repos live (for admin reference) */
  workspace?: string;
  /** HTTP base URL where this runner accepts requests (e.g. "http://192.168.1.5:3001") */
  httpUrl?: string;
  status: RunnerStatus;
  activeThreadCount: number;
  /** Project IDs assigned to this runner by the admin */
  assignedProjectIds: string[];
  registeredAt: string;
  lastHeartbeatAt: string;
}

// ─── HTTP: Registration ─────────────────────────────────

export interface RunnerRegisterRequest {
  /** Friendly name for this runner (e.g. "Argenis MacBook") */
  name: string;
  /** Machine hostname */
  hostname: string;
  /** Operating system (e.g. "linux", "darwin", "win32") */
  os: string;
  /** Optional base workspace directory where repos live */
  workspace?: string;
  /** HTTP base URL where this runner accepts proxied requests (e.g. "http://192.168.1.5:3001").
   *  Optional — if not provided, the server uses the WebSocket tunnel for all communication. */
  httpUrl?: string;
}

export interface RunnerRegisterResponse {
  runnerId: string;
  /** Token for authenticating subsequent requests */
  token: string;
}

// ─── HTTP: Heartbeat ────────────────────────────────────

export interface RunnerHeartbeatRequest {
  activeThreadIds: string[];
}

export interface RunnerHeartbeatResponse {
  ok: boolean;
}

// ─── HTTP: Task Polling ─────────────────────────────────

export type RunnerTaskType = 'start_agent' | 'stop_agent' | 'send_message' | 'git_operation';

export interface RunnerTask {
  taskId: string;
  type: RunnerTaskType;
  threadId: string;
  payload: RunnerTaskPayload;
  createdAt: string;
}

export type RunnerTaskPayload =
  | StartAgentPayload
  | StopAgentPayload
  | SendMessagePayload
  | GitOperationPayload;

// ── Start Agent ──

export interface StartAgentPayload {
  type: 'start_agent';
  prompt: string;
  /** The working directory where the agent should run (resolved by the central server) */
  cwd: string;
  model: AgentModel;
  provider: AgentProvider;
  permissionMode: PermissionMode;
  images?: unknown[];
  allowedTools?: string[];
  disallowedTools?: string[];
  sessionId?: string;
  systemPrefix?: string;
}

// ── Stop Agent ──

export interface StopAgentPayload {
  type: 'stop_agent';
}

// ── Send Follow-up Message ──

export interface SendMessagePayload {
  type: 'send_message';
  content: string;
  model?: AgentModel;
  permissionMode?: PermissionMode;
  images?: unknown[];
}

// ── Git Operations ──

export type GitOperationType =
  | 'diff'
  | 'diff_summary'
  | 'single_file_diff'
  | 'stage'
  | 'unstage'
  | 'revert'
  | 'commit'
  | 'push'
  | 'create_pr'
  | 'merge'
  | 'branches'
  | 'current_branch'
  | 'default_branch'
  | 'log'
  | 'status_summary'
  | 'pull'
  | 'stash'
  | 'stash_pop'
  | 'stash_list'
  | 'reset_soft'
  | 'create_worktree'
  | 'list_worktrees'
  | 'remove_worktree';

export interface GitOperationPayload {
  type: 'git_operation';
  operation: GitOperationType;
  cwd: string;
  params: Record<string, unknown>;
}

// ─── HTTP: Task Result ──────────────────────────────────

export interface RunnerTaskResultRequest {
  taskId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── HTTP: Git Operation (Direct) ───────────────────────
// These allow the central server to proxy git requests to the runner

export interface RunnerGitRequest {
  operation: GitOperationType;
  cwd: string;
  params: Record<string, unknown>;
}

export interface RunnerGitResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── HTTP: Project Assignment ───────────────────────────
// Admin assigns projects to runners from the central server UI.
// The runner never needs to know project IDs — it just executes
// tasks at the cwd the server provides.

export interface RunnerProjectAssignment {
  runnerId: string;
  projectId: string;
  /** The local path on the runner machine where this project lives */
  localPath: string;
  assignedAt: string;
}

export interface AssignProjectRequest {
  projectId: string;
  /** The local path on the runner machine where this project repo lives */
  localPath: string;
}

export interface UnassignProjectRequest {
  projectId: string;
}

// ─── Socket.IO: Agent Streaming ─────────────────────────
// The runner connects to the central server via Socket.IO to
// stream real-time agent events (messages, tool calls, status changes).
// Authentication is handled via Socket.IO handshake auth (bearer token).
// Tunnel requests use Socket.IO emit + ack callbacks.

// ─── Pending Tasks Response ─────────────────────────────

export interface PendingTasksResponse {
  tasks: RunnerTask[];
}

// ─── Data Persistence Protocol ──────────────────────────
// Runner → Server: stream data for persistence
// Instead of persisting locally, the runner sends data to the server

export type RunnerDataMessage =
  | DataInsertMessage
  | DataInsertToolCall
  | DataUpdateThread
  | DataUpdateMessage
  | DataUpdateToolCallOutput
  | DataSaveThreadEvent
  | DataInsertComment;

/** Runner → Server: persist a new message */
export interface DataInsertMessage {
  type: 'data:insert_message';
  requestId: string;
  payload: {
    threadId: string;
    role: string;
    content: string;
    images?: string | null;
    model?: string | null;
    permissionMode?: string | null;
    author?: string | null;
  };
}

/** Runner → Server: persist a new tool call */
export interface DataInsertToolCall {
  type: 'data:insert_tool_call';
  requestId: string;
  payload: {
    messageId: string;
    name: string;
    input: string;
    author?: string | null;
    parentToolCallId?: string | null;
  };
}

/** Runner → Server: update thread fields */
export interface DataUpdateThread {
  type: 'data:update_thread';
  payload: {
    threadId: string;
    updates: Record<string, any>;
  };
}

/** Runner → Server: update message content */
export interface DataUpdateMessage {
  type: 'data:update_message';
  payload: {
    messageId: string;
    content: string;
  };
}

/** Runner → Server: update tool call output */
export interface DataUpdateToolCallOutput {
  type: 'data:update_tool_call_output';
  payload: {
    toolCallId: string;
    output: string;
  };
}

/** Runner → Server: save thread event */
export interface DataSaveThreadEvent {
  type: 'data:save_thread_event';
  payload: {
    threadId: string;
    eventType: string;
    data: Record<string, unknown>;
  };
}

/** Runner → Server: insert a comment */
export interface DataInsertComment {
  type: 'data:insert_comment';
  payload: {
    threadId: string;
    userId: string;
    source: string;
    content: string;
  };
}

// ─── Data Persistence Responses ─────────────────────────
// Server → Runner: acknowledge data operations

export type ServerDataResponse = DataInsertMessageResponse | DataInsertToolCallResponse | DataAck;

/** Server → Runner: response with generated ID for inserted message */
export interface DataInsertMessageResponse {
  type: 'data:insert_message_response';
  requestId: string;
  messageId: string;
}

/** Server → Runner: response with generated ID for inserted tool call */
export interface DataInsertToolCallResponse {
  type: 'data:insert_tool_call_response';
  requestId: string;
  toolCallId: string;
}

/** Server → Runner: generic acknowledgment */
export interface DataAck {
  type: 'data:ack';
  requestId: string;
  success: boolean;
  error?: string;
}

// ─── Data Query Protocol ────────────────────────────────
// Runner → Server: query data from the server
// Used when runner needs to read data it doesn't have locally

export type RunnerDataQuery = DataGetThread | DataGetToolCall | DataFindToolCall;

/** Runner → Server: get thread by ID */
export interface DataGetThread {
  type: 'data:get_thread';
  requestId: string;
  threadId: string;
}

/** Runner → Server: get tool call by ID */
export interface DataGetToolCall {
  type: 'data:get_tool_call';
  requestId: string;
  toolCallId: string;
}

/** Runner → Server: find tool call by messageId + name + input (dedup) */
export interface DataFindToolCall {
  type: 'data:find_tool_call';
  requestId: string;
  payload: {
    messageId: string;
    name: string;
    input: string;
  };
}

// Server → Runner: query responses
export type ServerDataQueryResponse =
  | DataGetThreadResponse
  | DataGetToolCallResponse
  | DataFindToolCallResponse;

export interface DataGetThreadResponse {
  type: 'data:get_thread_response';
  requestId: string;
  thread: Record<string, any> | null;
}

export interface DataGetToolCallResponse {
  type: 'data:get_tool_call_response';
  requestId: string;
  toolCall: { id: string; name: string; input: string | null; output?: string | null } | null;
}

export interface DataFindToolCallResponse {
  type: 'data:find_tool_call_response';
  requestId: string;
  toolCall: { id: string } | null;
}
