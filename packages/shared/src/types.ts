// ─── Projects ────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

// ─── Threads ─────────────────────────────────────────────

export type ThreadMode = 'local' | 'worktree';
export type ThreadStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped';

export type ClaudeModel = 'sonnet' | 'opus' | 'haiku';
export type PermissionMode = 'plan' | 'autoEdit' | 'confirmEdit';

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  mode: ThreadMode;
  status: ThreadStatus;
  permissionMode: PermissionMode;
  branch?: string;
  worktreePath?: string;
  sessionId?: string;
  cost: number;
  archived?: boolean;
  createdAt: string;
  completedAt?: string;
}

// ─── Messages ────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ImageAttachment {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export interface Message {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  images?: ImageAttachment[];
  timestamp: string;
}

// ─── Tool Calls ──────────────────────────────────────────

export interface ToolCall {
  id: string;
  messageId: string;
  name: string;
  input: string;
  output?: string;
}

// ─── WebSocket Events ────────────────────────────────────

export type WSEventType =
  | 'agent:init'
  | 'agent:message'
  | 'agent:tool_call'
  | 'agent:tool_output'
  | 'agent:status'
  | 'agent:result'
  | 'agent:error'
  | 'command:output'
  | 'command:status';

export interface WSEvent {
  type: WSEventType;
  threadId: string;
  data: unknown;
}

// ─── Startup Commands ────────────────────────────────────

export interface StartupCommand {
  id: string;
  projectId: string;
  label: string;
  command: string;
  sortOrder: number;
  createdAt: string;
}

// ─── Git Diffs ───────────────────────────────────────────

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileDiff {
  path: string;
  status: FileStatus;
  diff: string;
  staged: boolean;
}

// ─── API Request/Response types ──────────────────────────

export interface CreateProjectRequest {
  name: string;
  path: string;
}

export interface CreateThreadRequest {
  title: string;
  mode: ThreadMode;
  model?: ClaudeModel;
  permissionMode?: PermissionMode;
  branch?: string;
  prompt: string;
}

export interface SendMessageRequest {
  content: string;
  model?: ClaudeModel;
  permissionMode?: PermissionMode;
  images?: ImageAttachment[];
}

export interface StageRequest {
  paths: string[];
}

export interface CommitRequest {
  message: string;
}

export interface CreatePRRequest {
  title: string;
  body: string;
}

// ─── MCP Servers ────────────────────────────────────────

export type McpServerType = 'stdio' | 'http' | 'sse';

export interface McpServer {
  name: string;
  type: McpServerType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface McpListResponse {
  servers: McpServer[];
}

export interface McpAddRequest {
  name: string;
  type: McpServerType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  scope?: 'project' | 'user';
  projectPath: string;
}

export interface McpRemoveRequest {
  name: string;
  projectPath: string;
  scope?: 'project' | 'user';
}

// ─── Skills ─────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  source: string;
  sourceUrl?: string;
  installedAt?: string;
  updatedAt?: string;
}

export interface SkillListResponse {
  skills: Skill[];
}

export interface SkillAddRequest {
  identifier: string;
}

export interface SkillRemoveRequest {
  name: string;
}
