// ─── Thread Machine (re-exported for convenience) ────────
export type { ResumeReason } from './thread-machine.js';

// ─── Auth ────────────────────────────────────────────────

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

// ─── Teams / Organizations ───────────────────────────────

export type TeamRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
  metadata?: string | null;
  anthropicApiKey?: string | null; // Encrypted at rest
  defaultModel?: string | null;
  defaultMode?: string | null;
  defaultPermissionMode?: string | null;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  userId: string;
  organizationId: string;
  role: TeamRole;
  username?: string;
  displayName?: string;
  email?: string;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  organizationId: string;
  role: TeamRole;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  inviterId: string;
  expiresAt: string;
}

export interface TeamProject {
  teamId: string;
  projectId: string;
}

// ─── User Profile (Git Identity) ─────────────────────────

export interface UserProfile {
  id: string;
  userId: string;
  gitName: string | null;
  gitEmail: string | null;
  /** Map of provider key ID → whether a key is set (e.g. { github: true, minimax: false }). */
  providerKeys: Record<string, boolean>;
  /** @deprecated Use providerKeys['github'] */
  hasGithubToken: boolean;
  /** @deprecated Use providerKeys['assemblyai'] */
  hasAssemblyaiKey: boolean;
  /** @deprecated Use providerKeys['minimax'] */
  hasMinimaxApiKey: boolean;
  setupCompleted: boolean;
  defaultEditor: string | null;
  useInternalEditor: boolean | null;
  terminalShell: string | null;
  toolPermissions: Record<string, string> | null;
  theme: string | null;
  runnerInviteToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateProfileRequest {
  gitName?: string;
  gitEmail?: string;
  /** Set or clear a provider key by canonical ID. Value is plaintext; null clears it. */
  providerKey?: { id: string; value: string | null };
  /** @deprecated Use providerKey: { id: 'github', value } */
  githubToken?: string | null;
  /** @deprecated Use providerKey: { id: 'assemblyai', value } */
  assemblyaiApiKey?: string | null;
  /** @deprecated Use providerKey: { id: 'minimax', value } */
  minimaxApiKey?: string | null;
  setupCompleted?: boolean;
  defaultEditor?: string;
  useInternalEditor?: boolean;
  terminalShell?: string;
  toolPermissions?: Record<string, string>;
  theme?: string;
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

export interface EnrichedGitHubIssue extends GitHubIssue {
  linkedBranch: string | null;
  linkedPR: { number: number; url: string; state: string } | null;
  suggestedBranchName: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  user: {
    login: string;
    avatar_url: string;
  } | null;
  created_at: string;
  updated_at: string;
  head: { ref: string; label: string };
  base: { ref: string; label: string };
  draft: boolean;
  labels: Array<{
    name: string;
    color: string;
  }>;
  merged_at: string | null;
}

// ─── PR Detail (rich data for PR Summary Card) ───────────

export type CICheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'stale'
  | null;

export interface CICheck {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: CICheckConclusion;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  app_name: string | null;
}

export type MergeableState = 'mergeable' | 'conflicting' | 'unknown';
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export interface PRDetail {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  mergeable_state: MergeableState;
  html_url: string;
  additions: number;
  deletions: number;
  changed_files: number;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string; avatar_url: string } | null;
  review_decision: ReviewDecision;
  checks: CICheck[];
  checks_passed: number;
  checks_failed: number;
  checks_pending: number;
  created_at: string;
  updated_at: string;
}

// ─── PR Review Threads (inline comments) ─────────────────

export interface PRThreadComment {
  id: number;
  author: string;
  author_avatar_url: string;
  body: string;
  created_at: string;
  updated_at: string;
  author_association: string;
}

export interface PRReviewThread {
  id: number;
  path: string;
  line: number | null;
  original_line: number | null;
  side: 'LEFT' | 'RIGHT';
  start_line: number | null;
  is_resolved: boolean;
  is_outdated: boolean;
  comments: PRThreadComment[];
}

export interface CloneRepoRequest {
  cloneUrl: string;
  destinationPath: string;
  name?: string;
}

// ─── Projects ────────────────────────────────────────────

export type FollowUpMode = 'interrupt' | 'queue' | 'ask';

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
  defaultBranch?: string;
  urls?: string[];
  systemPrompt?: string;
  launcherUrl?: string;
  memoryEnabled?: boolean;
  userId: string;
  sortOrder: number;
  createdAt: string;
  isTeamProject?: boolean;
  /** Name of the organization this project belongs to (set when listing org projects) */
  organizationName?: string;
  /** Per-user local path for shared projects (set by non-owner members) */
  localPath?: string;
  /** True when the user needs to configure their local directory for a shared project */
  needsSetup?: boolean;
}

// ─── Arcs ───────────────────────────────────────────────

export interface Arc {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  createdAt: string;
  /** Number of linked threads (populated in list queries) */
  threadCount?: number;
}

// ─── Threads ─────────────────────────────────────────────

export type ThreadPurpose = 'explore' | 'plan' | 'implement';
export type ThreadMode = 'local' | 'worktree';
export type ThreadRuntime = 'local' | 'remote';
export type ThreadStatus =
  | 'setting_up'
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

export type AgentProvider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'deepagent'
  | 'llm-api'
  | 'openswe'
  | 'external';

export type ThreadSource = 'web' | 'chrome_extension' | 'api' | 'automation' | 'ingest';

export type ClaudeModel = 'sonnet' | 'sonnet-4.6' | 'opus' | 'haiku';
export type CodexModel = 'o3' | 'o4-mini' | 'codex-mini';
export type GeminiModel =
  | 'gemini-2.0-flash'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-pro'
  | 'gemini-3-flash-preview'
  | 'gemini-3-pro-preview';
export type DeepAgentModel =
  | 'minimax-m2.7'
  | 'minimax-m2.7-highspeed'
  | 'deepagent-gpt-4o'
  | 'deepagent-sonnet'
  | 'deepagent-gemini-2.5-flash'
  | 'deepagent-gemini-2.5-pro'
  | 'deepagent-gemini-3-flash'
  | 'deepagent-gemini-3-pro';
export type OpenSWEModel = 'openswe-default';
export type AgentModel = ClaudeModel | CodexModel | GeminiModel | DeepAgentModel | OpenSWEModel;
export type PermissionMode = 'plan' | 'auto' | 'autoEdit' | 'confirmEdit' | 'ask';
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

// ─── Agent Definitions ──────────────────────────────────

export interface AgentDefinition {
  /** Unique identifier for this agent role (e.g. 'reviewer', 'corrector', 'arc-explore'). */
  name: string;
  /** Human-readable display label. */
  label: string;
  /** The system prompt — static string or function that receives context and returns the prompt. */
  systemPrompt: string | ((context: Record<string, string>) => string);
  /** Default model for this agent role. */
  model: AgentModel;
  /** Default provider. */
  provider: AgentProvider;
  /** Default permission mode. */
  permissionMode: PermissionMode;
  /** Tools that should be disabled for this agent role. */
  disallowedTools?: string[];
}

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
  arcId?: string;
  purpose: ThreadPurpose;
  runtime: ThreadRuntime;
  containerUrl?: string;
  containerName?: string;
  commentCount?: number;
  /** Why context recovery is needed (e.g. model/provider changed mid-thread) */
  contextRecoveryReason?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Creator/agent that generated this thread (user ID, 'external', 'pipeline', 'automation', etc.) */
  createdBy?: string;
  /** Snippet of the last assistant message (populated in list queries) */
  lastAssistantMessage?: string;
}

export interface PaginatedThreadsResponse {
  threads: Thread[];
  total: number;
  hasMore: boolean;
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
  /** Last user message — always included even when messages are paginated,
   *  so the UI can show the sticky prompt without loading all messages. */
  lastUserMessage?: Message & { toolCalls?: ToolCall[] };
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
  /** Links subagent tool calls to their parent Task tool call */
  parentToolCallId?: string;
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
  parentToolCallId?: string;
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
  stage?: ThreadStage;
  errorReason?: string;
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

export interface WSPtyErrorData {
  ptyId: string;
  error: string;
}

export interface WSPtySessionData {
  ptyId: string;
  cwd: string;
  shell?: string;
}

export interface WSPtySessionsData {
  sessions: WSPtySessionData[];
}

export interface WSQueueUpdateData {
  threadId: string;
  queuedCount: number;
  nextMessage?: string;
  /** Content of the message that was just dequeued and is now being processed */
  dequeuedMessage?: string;
  /** Images attached to the dequeued message */
  dequeuedImages?: ImageAttachment[];
}

// ─── Test Runner ─────────────────────────────────────────

export interface TestFile {
  path: string; // relative to project root, e.g. "e2e/app.spec.ts"
}

export interface TestSpec {
  id: string; // Playwright spec id or "file:line" fallback
  title: string; // e.g. "A.1 Sidebar navigation icons have accessible labels"
  file: string; // relative path
  line: number;
  column: number;
  projects: string[]; // Playwright projects this spec runs in (e.g. ["chromium", "firefox"])
}

export interface TestSuite {
  title: string; // e.g. "Logger - Crear logs con metadata"
  file: string;
  line: number;
  column: number;
  specs: TestSpec[];
  suites: TestSuite[]; // nested describe blocks
}

export interface DiscoverTestsResponse {
  file: string;
  specs: TestSpec[]; // flat list (backwards compat)
  suites: TestSuite[]; // hierarchical structure with describe blocks
  projects: string[]; // Playwright projects (e.g. ["chromium", "firefox", "webkit"])
}

export interface RunTestRequest {
  file: string; // relative path of the test file to run
  line?: number; // when set, runs only the test at this line
  projects?: string[]; // Playwright projects to run (e.g. ["chromium"])
}

export interface RunTestResponse {
  runId: string;
}

export type TestFileStatus = 'idle' | 'running' | 'passed' | 'failed' | 'stopped';

// ─── Test Action Types (Playwright reporter structured actions) ─────

export type TestActionCategory = 'pw:api' | 'expect' | 'fixture' | 'hook' | 'test.step';

export interface TestActionBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WSTestActionData {
  /** Unique action id, e.g. "step-0" */
  id: string;
  /** Human-readable action title, e.g. "page.click('button.submit')" */
  title: string;
  /** Playwright step category */
  category: TestActionCategory;
  /** CSS selector extracted from the action title (if applicable) */
  selector?: string;
  /** Epoch ms when this step started */
  startTime: number;
  /** Epoch ms when this step ended (set on stepEnd) */
  endTime?: number;
  /** Duration in ms */
  duration?: number;
  /** Error message if step failed */
  error?: string;
  /** Parent step id for nested steps */
  parentId?: string;
  /** Element bounding box at action time (resolved via CDP) */
  boundingBox?: TestActionBoundingBox;
  /** Timestamp of the nearest captured frame */
  frameTimestamp?: number;
}

// ─── Test WebSocket Event Data ──────────────────────────────────────

export interface WSTestFrameData {
  data: string; // base64 JPEG
  timestamp: number;
}

export interface WSTestOutputData {
  line: string;
  stream: 'stdout' | 'stderr';
}

export interface WSTestStatusData {
  status: TestFileStatus;
  file: string;
  runId: string;
  exitCode?: number;
  error?: string;
}

export type TestConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';

export interface WSTestConsoleData {
  level: TestConsoleLevel;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp: number;
}

export interface TestNetworkEntry {
  id: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
  mimeType?: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  size?: number;
  failed?: boolean;
  errorText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  responseBody?: string;
  responseBodyBase64?: boolean;
}

export interface WSTestNetworkData {
  entry: TestNetworkEntry;
  phase: 'request' | 'response' | 'completed' | 'failed';
}

export interface WSTestErrorData {
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
  timestamp: number;
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
  branch?: string | null;
  worktreePath?: string | null;
  mode?: string;
  mergedAt?: string;
}

export interface WSThreadDeletedData {
  projectId: string;
}

export interface WSThreadStageChangedData {
  fromStage: ThreadStage | null;
  toStage: ThreadStage;
  projectId: string;
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

export interface WSWorktreeSetupData {
  step: string;
  label: string;
  status: 'running' | 'completed' | 'failed';
  error?: string;
}

// ─── Git Workflow (server-side orchestration) ────────────

export type GitWorkflowAction =
  | 'commit'
  | 'amend'
  | 'commit-push'
  | 'commit-pr'
  | 'commit-merge'
  | 'push'
  | 'merge'
  | 'create-pr';

export interface GitWorkflowRequest {
  action: GitWorkflowAction;
  message?: string;
  filesToStage?: string[];
  filesToUnstage?: string[];
  amend?: boolean;
  noVerify?: boolean;
  prTitle?: string;
  prBody?: string;
  targetBranch?: string;
  cleanup?: boolean;
}

export interface GitWorkflowProgressStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  url?: string;
  subItems?: {
    label: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    error?: string;
  }[];
}

export interface WSGitWorkflowProgressData {
  workflowId: string;
  status: 'started' | 'step_update' | 'completed' | 'failed';
  title: string;
  action: GitWorkflowAction;
  steps: GitWorkflowProgressStep[];
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
  | { type: 'pty:error'; threadId: string; data: WSPtyErrorData }
  | { type: 'pty:sessions'; threadId: ''; data: WSPtySessionsData }
  | { type: 'thread:created'; threadId: string; data: WSThreadCreatedData }
  | { type: 'thread:deleted'; threadId: string; data: WSThreadDeletedData }
  | { type: 'thread:stage-changed'; threadId: string; data: WSThreadStageChangedData }
  | { type: 'thread:comment_deleted'; threadId: string; data: WSCommentDeletedData }
  | { type: 'thread:updated'; threadId: string; data: WSThreadUpdatedData }
  | { type: 'thread:queue_update'; threadId: string; data: WSQueueUpdateData }
  | { type: 'workflow:step'; threadId: string; data: WSWorkflowStepData }
  | { type: 'workflow:status'; threadId: string; data: WSWorkflowStatusData }
  | { type: 'thread:event'; threadId: string; data: WSThreadEventData }
  | { type: 'git:workflow_progress'; threadId: string; data: WSGitWorkflowProgressData }
  | { type: 'worktree:setup'; threadId: string; data: WSWorktreeSetupData }
  | { type: 'worktree:setup_complete'; threadId: string; data: WSWorktreeSetupCompleteData }
  | { type: 'clone:progress'; threadId: string; data: WSCloneProgressData }
  | { type: 'pipeline:run_started'; threadId: string; data: WSPipelineRunStartedData }
  | { type: 'pipeline:stage_update'; threadId: string; data: WSPipelineStageUpdateData }
  | { type: 'pipeline:run_completed'; threadId: string; data: WSPipelineRunCompletedData }
  | { type: 'org:member_added'; threadId: ''; data: WSOrgMemberData }
  | { type: 'org:member_removed'; threadId: ''; data: WSOrgMemberData }
  | { type: 'org:invitation_received'; threadId: ''; data: WSOrgInvitationData }
  | { type: 'test:frame'; threadId: string; data: WSTestFrameData }
  | { type: 'test:output'; threadId: string; data: WSTestOutputData }
  | { type: 'test:status'; threadId: string; data: WSTestStatusData }
  | { type: 'test:console'; threadId: string; data: WSTestConsoleData }
  | { type: 'test:network'; threadId: string; data: WSTestNetworkData }
  | { type: 'test:error'; threadId: string; data: WSTestErrorData }
  | { type: 'test:action'; threadId: string; data: WSTestActionData };

export interface WSOrgMemberData {
  organizationId: string;
  userId: string;
  role: TeamRole;
}

export interface WSOrgInvitationData {
  invitationId: string;
  organizationId: string;
  organizationName: string;
  role: TeamRole;
}

export interface WSWorktreeSetupCompleteData {
  branch: string;
  worktreePath?: string;
}

export interface WSCloneProgressData {
  cloneId: string;
  phase: string;
  percent?: number;
  error?: string;
}

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

// ─── Project Hooks (Husky-backed) ────────────────────────

export type HookType =
  | 'pre-commit'
  | 'commit-msg'
  | 'pre-push'
  | 'post-commit'
  | 'post-merge'
  | 'post-checkout';

export const HOOK_TYPES: HookType[] = [
  'pre-commit',
  'commit-msg',
  'pre-push',
  'post-commit',
  'post-merge',
  'post-checkout',
];

/** A single command within a hook type */
export interface HookCommand {
  label: string;
  command: string;
  enabled?: boolean; // defaults to true
}

/** Flat representation of a hook command for the UI (includes derived fields) */
export interface ProjectHook {
  hookType: HookType;
  index: number; // position within the hookType's commands array
  label: string;
  command: string;
  enabled: boolean;
}

// ─── Git Diffs ───────────────────────────────────────────

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'conflicted';

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
  additions?: number;
  deletions?: number;
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
  branchKey: string;
  state: GitSyncState;
  dirtyFileCount: number;
  unpushedCommitCount: number;
  unpulledCommitCount: number;
  hasRemoteBranch: boolean;
  isMergedIntoBase: boolean;
  linesAdded: number;
  linesDeleted: number;
  /** PR number if the branch has an open/merged PR on GitHub */
  prNumber?: number;
  /** PR URL on GitHub */
  prUrl?: string;
  /** PR state: OPEN, MERGED, or CLOSED */
  prState?: 'OPEN' | 'MERGED' | 'CLOSED';
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
  runtime?: ThreadRuntime;
  provider?: AgentProvider;
  model?: AgentModel;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  source?: ThreadSource;
  baseBranch?: string;
  prompt: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  worktreePath?: string;
  parentThreadId?: string;
  arcId?: string;
  purpose?: ThreadPurpose;
}

// ─── Arcs API ───────────────────────────────────────────

export interface CreateArcRequest {
  name: string;
}

export interface ArcArtifacts {
  proposal?: string;
  design?: string;
  tasks?: string;
  specs?: Record<string, string>;
}

export interface ArcWithArtifacts extends Arc {
  artifacts: ArcArtifacts;
}

export interface SendMessageRequest {
  content: string;
  provider?: AgentProvider;
  model?: AgentModel;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  images?: ImageAttachment[];
  allowedTools?: string[];
  disallowedTools?: string[];
  forceQueue?: boolean;
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
  /** Whether this automation was created in the UI or synced from .funny.json */
  source?: AutomationSource;
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
  | 'git:reset_soft'
  | 'compact_boundary'
  | 'workflow:started'
  | 'workflow:completed'
  | 'workflow:hooks'
  | 'workflow:review'
  | 'workflow:fix'
  | 'workflow:precommit_fix'
  | 'pipeline:started'
  | 'pipeline:reviewer_started'
  | 'pipeline:review_verdict'
  | 'pipeline:corrector_started'
  | 'pipeline:fix_applied'
  | 'pipeline:completed'
  | 'pipeline:precommit_hooks'
  | 'pipeline:precommit_fixer_started'
  | 'pipeline:precommit_fixing'
  | 'pipeline:precommit_fixed'
  | 'pipeline:precommit_failed';

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

// ─── Pipelines ──────────────────────────────────────────

export type PipelineStatus = 'idle' | 'running' | 'completed' | 'failed';
export type PipelineRunStatus =
  | 'running'
  | 'reviewing'
  | 'fixing'
  | 'completed'
  | 'failed'
  | 'skipped';
export type PipelineStageType = 'reviewer' | 'corrector';
export type PipelineVerdict = 'pass' | 'fail';

export interface PipelineStageConfig {
  type: PipelineStageType;
  model: AgentModel;
  permissionMode: PermissionMode;
  prompt: string;
}

export interface Pipeline {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  enabled: boolean;
  reviewModel: AgentModel;
  fixModel: AgentModel;
  maxIterations: number;
  precommitFixEnabled: boolean;
  precommitFixModel: AgentModel;
  precommitFixMaxIterations: number;
  reviewerPrompt?: string;
  correctorPrompt?: string;
  precommitFixerPrompt?: string;
  commitMessagePrompt?: string;
  testEnabled: boolean;
  testCommand?: string;
  testFixEnabled: boolean;
  testFixModel: AgentModel;
  testFixMaxIterations: number;
  testFixerPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  threadId: string;
  status: PipelineRunStatus;
  currentStage: PipelineStageType;
  iteration: number;
  maxIterations: number;
  commitSha?: string;
  verdict?: PipelineVerdict;
  findings?: string;
  fixerThreadId?: string;
  precommitIteration?: number;
  hookName?: string;
  hookError?: string;
  createdAt: string;
  completedAt?: string;
}

// ─── Pipeline WebSocket Events ──────────────────────────

export interface WSPipelineRunStartedData {
  pipelineId: string;
  runId: string;
  threadId: string;
  commitSha?: string;
}

export interface WSPipelineStageUpdateData {
  pipelineId: string;
  runId: string;
  threadId: string;
  stage: PipelineStageType;
  iteration: number;
  maxIterations: number;
  verdict?: PipelineVerdict;
  findings?: string;
}

export interface WSPipelineRunCompletedData {
  pipelineId: string;
  runId: string;
  threadId: string;
  status: PipelineRunStatus;
  totalIterations: number;
}

// ─── Weave Semantic Merge ─────────────────────────────────

export interface WeaveStatus {
  driverInstalled: boolean;
  driverConfigured: boolean;
  attributesConfigured: boolean;
  status: 'active' | 'unconfigured' | 'not-installed';
}

// ─── Project Worktree Configuration (.funny.json) ───────

export interface FunnyPortGroup {
  name: string;
  basePort: number;
  envVars: string[];
}

/** A managed process definition from .funny.json or Procfile */
export interface FunnyProcessConfig {
  name: string;
  command: string;
  /** Auto-restart on non-zero exit (default: true for Procfile, false for .funny.json) */
  autoRestart?: boolean;
  /** Max restarts within restartWindowSec before giving up (default: 5) */
  maxRestarts?: number;
  /** Time window in seconds for restart counting (default: 60) */
  restartWindowSec?: number;
}

/** An automation definition from .funny.json */
export interface FunnyAutomationConfig {
  name: string;
  prompt: string;
  schedule: string;
  provider?: string;
  model?: string;
  permissionMode?: string;
}

export interface FunnyProjectConfig {
  /** Relative paths to .env files to copy into worktrees (e.g. "packages/runtime/.env") */
  envFiles?: string[];
  /** Port groups — each group gets one unique port shared across its envVars */
  portGroups?: FunnyPortGroup[];
  /** Shell commands to run in the worktree after creation (e.g. ["bun install"]) */
  postCreate?: string[];
  /** Managed processes — auto-started with the project, optionally auto-restarted */
  processes?: FunnyProcessConfig[];
  /** Automations — synced to DB on project load */
  automations?: FunnyAutomationConfig[];
}

/** Source of an automation: created in UI or synced from .funny.json config */
export type AutomationSource = 'ui' | 'config';

/** Process health metrics emitted via WebSocket */
export interface WSCommandMetricsData {
  commandId: string;
  projectId: string;
  uptime: number;
  restartCount: number;
  memoryUsageKB: number;
}

// ─── Native Git Build (WebSocket events) ────────────────

export interface WSNativeGitBuildOutputData {
  text: string;
  channel: 'stdout' | 'stderr';
}

export interface WSNativeGitBuildStatusData {
  status: 'building' | 'completed' | 'failed';
  exitCode?: number;
}

// ─── Paisley Park (Project Memory) ──────────────────────

export type FactType = 'decision' | 'bug' | 'pattern' | 'convention' | 'insight' | 'context';

export type DecayClass = 'slow' | 'normal' | 'fast';

export type MemoryScope = 'project' | 'operator' | 'team' | 'all';

export interface MemoryFact {
  id: string;
  type: FactType;
  confidence: number;
  sourceAgent: string | null;
  sourceOperator: string | null;
  sourceSession: string | null;
  validFrom: string; // ISO 8601
  invalidAt: string | null;
  ingestedAt: string; // ISO 8601
  invalidatedBy: string | null;
  supersededBy: string | null;
  tags: string[];
  related: string[];
  decayClass: DecayClass;
  accessCount: number;
  lastAccessed: string; // ISO 8601
  content: string;
}

export interface RecallOptions {
  limit?: number;
  scope?: MemoryScope;
  includeInvalidated?: boolean;
  minConfidence?: number;
  asOf?: string; // ISO 8601
  forOperator?: string;
}

export interface AddOptions {
  type: FactType;
  tags?: string[];
  confidence?: number;
  decayClass?: DecayClass;
  relatedTo?: string[];
  validFrom?: string; // ISO 8601
  scope?: MemoryScope;
  sourceAgent?: string;
  sourceOperator?: string;
  sourceSession?: string;
}

export interface SearchFilters {
  type?: FactType | FactType[];
  tags?: string[];
  sourceAgent?: string;
  validAt?: string; // ISO 8601
  createdAfter?: string; // ISO 8601
  createdBefore?: string; // ISO 8601
  minConfidence?: number;
}

export interface TimelineOptions {
  from?: string; // ISO 8601
  to?: string; // ISO 8601
  type?: FactType | FactType[];
  includeInvalidated?: boolean;
}

export interface MemoryRecallResult {
  facts: MemoryFact[];
  formattedContext: string;
  totalFound: number;
}
