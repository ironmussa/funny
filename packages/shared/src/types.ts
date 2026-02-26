// ─── Thread Machine (re-exported for convenience) ────────
export type { ResumeReason } from './thread-machine.js';

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

export interface GitHubIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  body: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  user: {
    login: string;
    avatar_url: string;
  } | null;
  labels: Array<{
    name: string;
    color: string;
  }>;
  comments: number;
  pull_request?: unknown;
}

export interface CloneRepoRequest {
  cloneUrl: string;
  destinationPath: string;
  name?: string;
}

// ─── Projects ────────────────────────────────────────────

export type FollowUpMode = 'interrupt' | 'queue';

export interface Project {
  id: string;
  name: string;
  path: string;
  color?: string;
  followUpMode?: FollowUpMode;
  defaultProvider?: AgentProvider;
  defaultModel?: AgentModel;
  defaultMode?: ThreadMode;
  defaultPermissionMode?: PermissionMode;
  userId: string;
  sortOrder: number;
  createdAt: string;
}

// ─── Threads ─────────────────────────────────────────────

export type ThreadMode = 'local' | 'worktree';
export type ThreadStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';
export type ThreadStage = 'backlog' | 'planning' | 'in_progress' | 'review' | 'done' | 'archived';
export type WaitingReason = 'question' | 'plan' | 'permission';

export type AgentProvider = 'claude' | 'codex' | 'gemini' | 'llm-api' | 'external';

export type ThreadSource = 'web' | 'chrome_extension' | 'api' | 'automation' | 'ingest';

export type ClaudeModel = 'sonnet' | 'sonnet-4.6' | 'opus' | 'haiku';
export type CodexModel = 'o3' | 'o4-mini' | 'codex-mini';
export type GeminiModel =
  | 'gemini-2.0-flash'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-pro'
  | 'gemini-3-flash-preview'
  | 'gemini-3-pro-preview';
export type AgentModel = ClaudeModel | CodexModel | GeminiModel;
export type PermissionMode = 'plan' | 'autoEdit' | 'confirmEdit';

export interface Thread {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  mode: ThreadMode;
  status: ThreadStatus;
  stage: ThreadStage;
  provider: AgentProvider;
  permissionMode: PermissionMode;
  model: AgentModel;
  branch?: string;
  baseBranch?: string;
  worktreePath?: string;
  sessionId?: string;
  initialPrompt?: string;
  cost: number;
  archived?: boolean;
  pinned?: boolean;
  automationId?: string;
  source: ThreadSource;
  externalRequestId?: string;
  parentThreadId?: string;
  commentCount?: number;
  createdAt: string;
  completedAt?: string;
  /** Creator/agent that generated this thread (user ID, 'external', 'pipeline', 'automation', etc.) */
  createdBy?: string;
}

// ─── Thread Comments ────────────────────────────────────

export type CommentSource = 'user' | 'system' | 'agent';

export interface ThreadComment {
  id: string;
  threadId: string;
  userId: string;
  source: CommentSource;
  content: string;
  createdAt: string;
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
  model?: AgentModel;
  /** Permission mode used when this user message was sent */
  permissionMode?: PermissionMode;
  /** Agent name, pipeline name, or user identifier that produced this message */
  author?: string;
}

// ─── Thread with Messages ────────────────────────────────

export interface ThreadWithMessages extends Thread {
  messages: (Message & { toolCalls?: ToolCall[] })[];
  hasMore?: boolean;
  initInfo?: { tools: string[]; cwd: string; model: string };
}

export interface PaginatedMessages {
  messages: (Message & { toolCalls?: ToolCall[] })[];
  hasMore: boolean;
}

// ─── Tool Calls ──────────────────────────────────────────

export interface ToolCall {
  id: string;
  messageId: string;
  name: string;
  input: string;
  output?: string;
  /** Agent name that executed this tool call (for pipeline threads) */
  author?: string;
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
  author?: string;
}

export interface WSToolCallData {
  toolCallId?: string;
  messageId?: string;
  name: string;
  input: unknown;
  author?: string;
}

export interface WSToolOutputData {
  toolCallId: string;
  output: string;
}

export interface WSStatusData {
  status: ThreadStatus;
  waitingReason?: WaitingReason;
  permissionRequest?: { toolName: string };
  permissionMode?: PermissionMode;
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

export interface WSCompactBoundaryData {
  trigger: 'manual' | 'auto';
  preTokens: number;
  timestamp: string;
}

export interface WSContextUsageData {
  inputTokens: number;
  outputTokens: number;
  cumulativeInputTokens: number;
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

export interface WSQueueUpdateData {
  threadId: string;
  queuedCount: number;
  nextMessage?: string;
}

export interface WSWorkflowStepData {
  runId: string;
  workflowName: string;
  stepName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: Record<string, unknown>;
}

export interface WSWorkflowStatusData {
  runId: string;
  workflowName: string;
  status: 'triggered' | 'running' | 'completed' | 'failed';
  qualityScores?: Record<string, { status: string; details: string }>;
}

export interface WSThreadCreatedData {
  projectId: string;
  title: string;
  source?: string;
}

export interface WSCommentDeletedData {
  commentId: string;
}

export interface WSThreadUpdatedData {
  status?: string;
  archived?: number;
  branch?: string;
  worktreePath?: string;
}

export interface WSAutomationRunUpdatedData {
  automationId: string;
  runId: string;
  triageStatus?: string;
  status?: string;
}

export interface WSThreadEventData {
  event: ThreadEvent;
}

export type WSEvent =
  | { type: 'agent:init'; threadId: string; data: WSInitData }
  | { type: 'agent:message'; threadId: string; data: WSMessageData }
  | { type: 'agent:tool_call'; threadId: string; data: WSToolCallData }
  | { type: 'agent:tool_output'; threadId: string; data: WSToolOutputData }
  | { type: 'agent:status'; threadId: string; data: WSStatusData }
  | { type: 'agent:result'; threadId: string; data: WSResultData }
  | { type: 'agent:error'; threadId: string; data: WSErrorData }
  | { type: 'agent:compact_boundary'; threadId: string; data: WSCompactBoundaryData }
  | { type: 'agent:context_usage'; threadId: string; data: WSContextUsageData }
  | { type: 'command:output'; threadId: string; data: WSCommandOutputData }
  | { type: 'command:status'; threadId: string; data: WSCommandStatusData }
  | { type: 'automation:run_started'; threadId: string; data: WSAutomationRunStartedData }
  | { type: 'automation:run_completed'; threadId: string; data: WSAutomationRunCompletedData }
  | { type: 'automation:run_updated'; threadId: string; data: WSAutomationRunUpdatedData }
  | { type: 'git:status'; threadId: string; data: WSGitStatusData }
  | { type: 'pty:data'; threadId: string; data: WSPtyDataData }
  | { type: 'pty:exit'; threadId: string; data: WSPtyExitData }
  | { type: 'thread:created'; threadId: string; data: WSThreadCreatedData }
  | { type: 'thread:comment_deleted'; threadId: string; data: WSCommentDeletedData }
  | { type: 'thread:updated'; threadId: string; data: WSThreadUpdatedData }
  | { type: 'thread:queue_update'; threadId: string; data: WSQueueUpdateData }
  | { type: 'workflow:step'; threadId: string; data: WSWorkflowStepData }
  | { type: 'workflow:status'; threadId: string; data: WSWorkflowStatusData }
  | { type: 'thread:event'; threadId: string; data: WSThreadEventData };

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

/** Lightweight file metadata without diff content (for summary endpoint). */
export interface FileDiffSummary {
  path: string;
  status: FileStatus;
  staged: boolean;
}

export interface DiffSummaryResponse {
  files: FileDiffSummary[];
  total: number;
  truncated: boolean;
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
  provider?: AgentProvider;
  model?: AgentModel;
  permissionMode?: PermissionMode;
  source?: ThreadSource;
  baseBranch?: string;
  prompt: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  worktreePath?: string;
  parentThreadId?: string;
}

export interface SendMessageRequest {
  content: string;
  provider?: AgentProvider;
  model?: AgentModel;
  permissionMode?: PermissionMode;
  images?: ImageAttachment[];
  allowedTools?: string[];
  disallowedTools?: string[];
}

// ─── Message Queue ──────────────────────────────────────

export interface QueuedMessage {
  id: string;
  threadId: string;
  content: string;
  provider?: string;
  model?: string;
  permissionMode?: string;
  sortOrder: number;
  createdAt: string;
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
  provider: AgentProvider;
  model: AgentModel;
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
  provider?: AgentProvider;
  model?: AgentModel;
  mode?: ThreadMode;
  permissionMode?: PermissionMode;
  baseBranch?: string;
}

export interface UpdateAutomationRequest {
  name?: string;
  prompt?: string;
  schedule?: AutomationSchedule;
  provider?: AgentProvider;
  model?: AgentModel;
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

// ─── Thread Events ──────────────────────────────────────

export type ThreadEventType =
  | 'git:changed'
  | 'git:commit'
  | 'git:push'
  | 'git:merge'
  | 'git:pr_created'
  | 'git:stage'
  | 'git:unstage'
  | 'git:revert'
  | 'git:pull'
  | 'git:stash'
  | 'git:stash_pop'
  | 'git:reset_soft';

export interface ThreadEvent {
  id: string;
  threadId: string;
  type: ThreadEventType;
  data: string;
  createdAt: string;
}

// ─── Code Review (ReviewBot) ────────────────────────────

export type ReviewFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'suggestion';
export type ReviewFindingCategory =
  | 'bug'
  | 'security'
  | 'performance'
  | 'style'
  | 'logic'
  | 'maintainability';

export interface CodeReviewFinding {
  severity: ReviewFindingSeverity;
  category: ReviewFindingCategory;
  file: string;
  line?: number;
  description: string;
  suggestion?: string;
}

export interface CodeReviewResult {
  prNumber: number;
  status: 'approved' | 'changes_requested' | 'commented';
  summary: string;
  findings: CodeReviewFinding[];
  duration_ms: number;
  model: string;
}

export interface TriggerReviewRequest {
  prNumber: number;
  model?: string;
  provider?: string;
}
