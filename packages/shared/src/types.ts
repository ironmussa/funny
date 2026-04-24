// ─── Thread Machine (re-exported for convenience) ────────
export type { ResumeReason } from './thread-machine.js';

// ─── Domain re-exports (split modules) ───────────────────
export type {
  UserRole,
  SafeUser,
  CreateUserRequest,
  UpdateUserRequest,
  TeamRole,
  Organization,
  TeamMember,
  Invitation,
  TeamProject,
  UserProfile,
  UpdateProfileRequest,
} from './types/auth.js';

export type {
  GitHubRepo,
  GitHubIssue,
  EnrichedGitHubIssue,
  GitHubPR,
  CICheckConclusion,
  CICheck,
  MergeableState,
  ReviewDecision,
  PRDetail,
  PRThreadComment,
  PRReviewThread,
  PRReactionSummary,
  PRIssueComment,
  PRReview,
  PRConversation,
  PRCommentKind,
  PRReactionContent,
  PRFile,
  PRCommit,
  CloneRepoRequest,
} from './types/github.js';

export type {
  FactType,
  DecayClass,
  MemoryScope,
  MemoryFact,
  RecallOptions,
  AddOptions,
  SearchFilters,
  TimelineOptions,
  MemoryRecallResult,
} from './types/memory.js';

export type {
  ReviewFindingSeverity,
  ReviewFindingCategory,
  CodeReviewFinding,
  CodeReviewResult,
  TriggerReviewRequest,
} from './types/review.js';

export type { WeaveStatus } from './types/weave.js';

export type { HookType, HookCommand, ProjectHook } from './types/hooks.js';
export { HOOK_TYPES } from './types/hooks.js';

export type {
  TestFile,
  TestSpec,
  TestSuite,
  DiscoverTestsResponse,
  RunTestRequest,
  RunTestResponse,
  TestFileStatus,
  TestActionCategory,
  TestActionBoundingBox,
  WSTestActionData,
  WSTestFrameData,
  WSTestOutputData,
  WSTestStatusData,
  TestConsoleLevel,
  WSTestConsoleData,
  TestNetworkEntry,
  WSTestNetworkData,
  WSTestErrorData,
} from './types/test.js';

export type {
  FunnyPortGroup,
  FunnyProcessConfig,
  FunnyAutomationConfig,
  FunnyProjectConfig,
  AutomationSource,
  WSCommandMetricsData,
  WSNativeGitBuildOutputData,
  WSNativeGitBuildStatusData,
} from './types/funny-config.js';

export type {
  McpServerType,
  McpServer,
  McpListResponse,
  McpAddRequest,
  McpOAuthStartRequest,
  McpOAuthStartResponse,
  McpRemoveRequest,
} from './types/mcp.js';

export type {
  Skill,
  SkillListResponse,
  SkillAddRequest,
  SkillRemoveRequest,
} from './types/skills.js';

export type { PluginCommand, Plugin, PluginListResponse } from './types/plugins.js';

export type {
  FileStatus,
  FileDiffKind,
  NestedDirtyStats,
  FileDiff,
  FileDiffSummary,
  DiffSummaryResponse,
  GitSyncState,
  GitStatusInfo,
  WSGitStatusData,
  MergeProgress,
  GitWorkflowAction,
  GitWorkflowRequest,
  GitWorkflowProgressStep,
  WSGitWorkflowProgressData,
} from './types/git.js';

export type {
  SystemPromptMode,
  DeepAgentTool,
  TemplateVariable,
  AgentTemplate,
  CreateAgentTemplateRequest,
  UpdateAgentTemplateRequest,
  AgentTemplateExportFile,
} from './types/agent-templates.js';
export { DEEPAGENT_TOOLS, BUILTIN_AGENT_TEMPLATES } from './types/agent-templates.js';

export type {
  PipelineStatus,
  PipelineRunStatus,
  PipelineStageType,
  PipelineVerdict,
  PipelineStageConfig,
  Pipeline,
  PipelineRun,
  WSPipelineRunStartedData,
  WSPipelineStageUpdateData,
  WSPipelineRunCompletedData,
} from './types/pipelines.js';

export type {
  AutomationSchedule,
  RunTriageStatus,
  Automation,
  AutomationRun,
  CreateAutomationRequest,
  UpdateAutomationRequest,
  InboxItem,
} from './types/automations.js';

export type { ThreadEventType, ThreadEvent } from './types/thread-events.js';

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
  defaultAgentTemplateId?: string;
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

export type AgentProvider = 'claude' | 'codex' | 'gemini' | 'deepagent' | 'llm-api' | 'external';

export type ThreadSource = 'web' | 'chrome_extension' | 'api' | 'automation' | 'ingest';

export type ClaudeModel = 'sonnet' | 'sonnet-4.6' | 'opus' | 'opus-4.7' | 'haiku';
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
  | 'deepagent-gemini-3-pro'
  | 'deepagent-grok-3'
  | 'deepagent-grok-3-mini'
  | 'deepagent-glm-5.1'
  | 'deepagent-glm-5-turbo'
  | 'deepagent-glm-5v-turbo';
export type AgentModel = ClaudeModel | CodexModel | GeminiModel | DeepAgentModel;
export type PermissionMode = 'plan' | 'auto' | 'autoEdit' | 'confirmEdit' | 'ask';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  /** Agent template used to configure this thread (Deep Agent only). */
  agentTemplateId?: string;
  /** Filled template variable values (key → value). */
  templateVariables?: Record<string, string>;
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
  agentTemplateId?: string;
  templateVariables?: Record<string, string>;
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

// Imports needed by local type aliases — pulled in from split modules.
import type { TeamRole } from './types/auth.js';
import type { WSGitStatusData, WSGitWorkflowProgressData } from './types/git.js';
import type {
  WSPipelineRunStartedData,
  WSPipelineStageUpdateData,
  WSPipelineRunCompletedData,
} from './types/pipelines.js';
import type {
  WSTestActionData,
  WSTestFrameData,
  WSTestOutputData,
  WSTestStatusData,
  WSTestConsoleData,
  WSTestNetworkData,
  WSTestErrorData,
} from './types/test.js';
import type { ThreadEvent } from './types/thread-events.js';
