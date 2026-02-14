// ─── Auth ────────────────────────────────────────────────

export type AuthMode = 'local' | 'multi';
export type UserRole = 'admin' | 'user';

export interface SafeUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  displayName: string;
  role: UserRole;
}

export interface UpdateUserRequest {
  displayName?: string;
  role?: UserRole;
  password?: string;
}

// ─── User Profile (Git Identity) ─────────────────────────

export interface UserProfile {
  id: string;
  userId: string;
  gitName: string | null;
  gitEmail: string | null;
  hasGithubToken: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateProfileRequest {
  gitName?: string;
  gitEmail?: string;
  githubToken?: string | null;
}

// ─── GitHub ──────────────────────────────────────────────

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
  language: string | null;
  updated_at: string;
  stargazers_count: number;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

export interface CloneRepoRequest {
  cloneUrl: string;
  destinationPath: string;
  name?: string;
}

// ─── Projects ────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  path: string;
  color?: string;
  userId: string;
  sortOrder: number;
  createdAt: string;
}

// ─── Threads ─────────────────────────────────────────────

export type ThreadMode = 'local' | 'worktree';
export type ThreadStatus = 'idle' | 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type ThreadStage = 'backlog' | 'in_progress' | 'review' | 'done' | 'archived';
export type WaitingReason = 'question' | 'plan' | 'permission';

export type ClaudeModel = 'sonnet' | 'opus' | 'haiku';
export type PermissionMode = 'plan' | 'autoEdit' | 'confirmEdit';

export interface Thread {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  mode: ThreadMode;
  status: ThreadStatus;
  stage: ThreadStage;
  permissionMode: PermissionMode;
  model: ClaudeModel;
  branch?: string;
  baseBranch?: string;
  worktreePath?: string;
  sessionId?: string;
  initialPrompt?: string;
  cost: number;
  archived?: boolean;
  pinned?: boolean;
  automationId?: string;
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
  /** Model used when this user message was sent */
  model?: ClaudeModel;
  /** Permission mode used when this user message was sent */
  permissionMode?: PermissionMode;
}

// ─── Thread with Messages ────────────────────────────────

export interface ThreadWithMessages extends Thread {
  messages: (Message & { toolCalls?: ToolCall[] })[];
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

export interface WSInitData {
  tools: string[];
  cwd: string;
  model: string;
}

export interface WSMessageData {
  messageId?: string;
  role: string;
  content: string;
}

export interface WSToolCallData {
  toolCallId?: string;
  messageId?: string;
  name: string;
  input: unknown;
}

export interface WSToolOutputData {
  toolCallId: string;
  output: string;
}

export interface WSStatusData {
  status: ThreadStatus;
  waitingReason?: WaitingReason;
  permissionRequest?: { toolName: string };
}

export interface WSResultData {
  status?: ThreadStatus;
  waitingReason?: WaitingReason;
  permissionRequest?: { toolName: string };
  cost?: number;
  duration?: number;
  result?: string;
}

export interface WSErrorData {
  error: string;
}

export interface WSCommandOutputData {
  commandId: string;
  data: string;
}

export interface WSCommandStatusData {
  commandId: string;
  projectId: string;
  label: string;
  status: 'running' | 'exited' | 'stopped';
  exitCode?: number;
}

export interface WSAutomationRunStartedData {
  automationId: string;
  runId: string;
}

export interface WSAutomationRunCompletedData {
  automationId: string;
  runId: string;
  hasFindings: boolean;
  summary?: string;
}

export interface WSPtyDataData {
  ptyId: string;
  data: string;
}

export interface WSPtyExitData {
  ptyId: string;
  exitCode: number;
}

export type WSEvent =
  | { type: 'agent:init'; threadId: string; data: WSInitData }
  | { type: 'agent:message'; threadId: string; data: WSMessageData }
  | { type: 'agent:tool_call'; threadId: string; data: WSToolCallData }
  | { type: 'agent:tool_output'; threadId: string; data: WSToolOutputData }
  | { type: 'agent:status'; threadId: string; data: WSStatusData }
  | { type: 'agent:result'; threadId: string; data: WSResultData }
  | { type: 'agent:error'; threadId: string; data: WSErrorData }
  | { type: 'command:output'; threadId: string; data: WSCommandOutputData }
  | { type: 'command:status'; threadId: string; data: WSCommandStatusData }
  | { type: 'automation:run_started'; threadId: string; data: WSAutomationRunStartedData }
  | { type: 'automation:run_completed'; threadId: string; data: WSAutomationRunCompletedData }
  | { type: 'git:status'; threadId: string; data: WSGitStatusData }
  | { type: 'pty:data'; threadId: string; data: WSPtyDataData }
  | { type: 'pty:exit'; threadId: string; data: WSPtyExitData };

export type WSEventType = WSEvent['type'];

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

// ─── Git Sync Status ────────────────────────────────────

export type GitSyncState = 'dirty' | 'unpushed' | 'pushed' | 'merged' | 'clean';

export interface GitStatusInfo {
  threadId: string;
  state: GitSyncState;
  dirtyFileCount: number;
  unpushedCommitCount: number;
  hasRemoteBranch: boolean;
  isMergedIntoBase: boolean;
  linesAdded: number;
  linesDeleted: number;
}

export interface WSGitStatusData {
  statuses: GitStatusInfo[];
}

// ─── Merge Agent ─────────────────────────────────────────

export interface MergeProgress {
  branch: string;
  status: 'merging' | 'conflict' | 'resolved' | 'done' | 'failed';
  message?: string;
}

// ─── API Request/Response types ──────────────────────────

export interface CreateProjectRequest {
  name: string;
  path: string;
}

export type ToolPermission = 'allow' | 'ask' | 'deny';

export interface CreateThreadRequest {
  title: string;
  mode: ThreadMode;
  model?: ClaudeModel;
  permissionMode?: PermissionMode;
  baseBranch?: string;
  prompt: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface SendMessageRequest {
  content: string;
  model?: ClaudeModel;
  permissionMode?: PermissionMode;
  images?: ImageAttachment[];
  allowedTools?: string[];
  disallowedTools?: string[];
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
  status?: 'ok' | 'needs_auth' | 'error';
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

// ─── MCP OAuth ──────────────────────────────────────────

export interface McpOAuthStartRequest {
  serverName: string;
  projectPath: string;
}

export interface McpOAuthStartResponse {
  authUrl: string;
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
  scope?: 'global' | 'project';
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

// ─── Plugins ─────────────────────────────────────────────

export interface PluginCommand {
  name: string;
  description: string;
}

export interface Plugin {
  name: string;
  description: string;
  author: string;
  installed: boolean;
  installedAt?: string;
  lastUpdated?: string;
  commands: PluginCommand[];
}

export interface PluginListResponse {
  plugins: Plugin[];
}

// ─── Automations ────────────────────────────────────────

// Cron expression string — e.g. "0 9 * * *" (daily at 9am)
export type AutomationSchedule = string;
export type RunTriageStatus = 'pending' | 'reviewed' | 'dismissed';

export interface Automation {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  model: ClaudeModel;
  mode: ThreadMode;
  permissionMode: PermissionMode;
  baseBranch?: string;
  enabled: boolean;
  maxRunHistory: number;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  threadId: string;
  status: 'running' | 'completed' | 'failed' | 'archived';
  triageStatus: RunTriageStatus;
  hasFindings?: boolean;
  summary?: string;
  startedAt: string;
  completedAt?: string;
}

export interface CreateAutomationRequest {
  projectId: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  model?: ClaudeModel;
  mode?: ThreadMode;
  permissionMode?: PermissionMode;
  baseBranch?: string;
}

export interface UpdateAutomationRequest {
  name?: string;
  prompt?: string;
  schedule?: AutomationSchedule;
  model?: ClaudeModel;
  mode?: ThreadMode;
  permissionMode?: PermissionMode;
  baseBranch?: string;
  enabled?: boolean;
  maxRunHistory?: number;
}

export interface InboxItem {
  run: AutomationRun;
  automation: Automation;
  thread: Thread;
}
