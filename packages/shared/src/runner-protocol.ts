/**
 * Runner ↔ Central Server Protocol Types
 *
 * Defines the contract between local runners and the central funny server.
 * Communication uses HTTP for request/response operations and WebSocket
 * only for real-time agent streaming.
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

// ─── WebSocket: Agent Streaming ─────────────────────────
// The runner connects to the central server via WebSocket to
// stream real-time agent events (messages, tool calls, status changes).

export type RunnerWSMessage = RunnerWSAuth | RunnerWSAgentEvent | RunnerWSPing;

export interface RunnerWSAuth {
  type: 'runner:auth';
  runnerId: string;
  token: string;
}

export interface RunnerWSAgentEvent {
  type: 'runner:agent_event';
  threadId: string;
  event: WSEvent;
}

export interface RunnerWSPing {
  type: 'runner:ping';
}

// Messages from Central Server → Runner via WebSocket
export type CentralWSMessage = CentralWSAuthOk | CentralWSPong | CentralWSCommand;

export interface CentralWSAuthOk {
  type: 'central:auth_ok';
}

export interface CentralWSPong {
  type: 'central:pong';
}

export interface CentralWSCommand {
  type: 'central:command';
  task: RunnerTask;
}

// ─── Pending Tasks Response ─────────────────────────────

export interface PendingTasksResponse {
  tasks: RunnerTask[];
}
