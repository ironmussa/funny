// ─── Primitives (re-exported for convenience) ────────────
// The actual definitions live in `./primitives.js` so sub-modules can
// depend on these without forming a cycle through the `types.js` barrel.
export type {
  ThreadMode,
  ThreadRuntime,
  ThreadStatus,
  ThreadStage,
  WaitingReason,
  ThreadSource,
  AgentProvider,
  PermissionMode,
  EffortLevel,
  FollowUpMode,
  ResumeReason,
} from './primitives.js';

// ─── Thread (interface lives in ./types/thread.js to avoid cycles) ──
import type {
  AgentProvider,
  EffortLevel,
  FollowUpMode,
  PermissionMode,
  ThreadMode,
  ThreadRuntime,
  ThreadSource,
} from './primitives.js';
import type { Thread, PaginatedThreadsResponse } from './types/thread.js';
export type { Thread, PaginatedThreadsResponse };

export type {
  PermissionDecision,
  PermissionApprovalCapability,
  PermissionRecoveryReason,
  PendingPermissionStatus,
  PendingPermissionRequest,
  PermissionRequestRecord,
  StalePermissionRequestError,
} from './types/permission-approvals.js';

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
  GitHubUserRef,
  PRFilterOptions,
  PRSortKey,
  CICheckConclusion,
  CICheck,
  MergeableState,
  ReviewDecision,
  PRDetail,
  PRThreadComment,
  PRReviewThread,
  PRReactionSummary,
  PRIssueComment,
  IssueTimelineActor,
  IssueTimelineRef,
  IssueTimelineEvent,
  IssueTimelineItem,
  PRReview,
  PRConversation,
  PRCommentKind,
  PRReactionContent,
  PRFile,
  PRCommit,
  CloneRepoRequest,
  ActionStatus,
  ActionRun,
  ActionRunsPage,
  ActionStep,
  ActionJob,
  ActionJobLog,
} from './types/github.js';

export type {
  ReviewFindingSeverity,
  ReviewFindingCategory,
  CodeReviewFinding,
  CodeReviewResult,
  TriggerReviewRequest,
} from './types/review.js';

export type { WeaveStatus } from './types/weave.js';
export type {
  ExternalClaudeSession,
  ExternalClaudeTranscript,
  ExternalClaudeTranscriptMessage,
  ExternalClaudeTranscriptToolCall,
} from './types/external-claude.js';

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
  BrowserSessionInputKind,
  BrowserSessionClosedReason,
  BrowserSessionNavAction,
  WSBrowserSessionOpenData,
  WSBrowserSessionNavigateData,
  WSBrowserSessionNavData,
  WSBrowserSessionInputData,
  WSBrowserSessionInspectAtData,
  WSBrowserSessionInspectRectData,
  WSBrowserSessionScreenshotData,
  WSBrowserSessionExecuteData,
  WSBrowserSessionHeartbeatData,
  WSBrowserSessionCloseData,
  WSBrowserSessionReadyData,
  WSBrowserSessionFrameData,
  WSBrowserSessionResultData,
  WSBrowserSessionConsoleData,
  WSBrowserSessionErrorData,
  WSBrowserSessionClosedData,
  WSBrowserSessionAgentOpenedData,
  WSBrowserSessionViewportData,
  WSBrowserSessionControllerData,
  WSBrowserSessionDialogData,
  WSBrowserSessionPointerData,
  WSBrowserSessionAgentActionData,
  WSBrowserSessionNavigatedData,
  WSBrowserSessionAudioData,
  BrowserSessionController,
  BrowserSessionCloseRequestReason,
  BrowserSessionPointerKind,
  BrowserSessionAgentAction,
  BrowserSessionAgentActionKind,
} from './types/browser-session.js';
export { threadBrowserSessionId, threadIdFromBrowserSessionId } from './types/browser-session.js';

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

export type {
  AgentResourceKind,
  ResourceOrigin,
  CommandTier,
  AgentResourceHiddenReason,
  ResourcePhase,
  AgentResource,
  SkillSource,
  CommandSource,
  ProviderResourceDescriptor,
  ResolveAgentResourcesInput,
  AgentResourcesResult,
} from './types/agent-resources.js';

export {
  DEFAULT_PROVIDER_RESOURCE_DESCRIPTOR,
  PROVIDER_RESOURCE_DESCRIPTORS,
  getProviderResourceDescriptor,
  resourceUsableByProvider,
} from './types/agent-resources.js';

export type { PluginCommand, Plugin, PluginListResponse } from './types/plugins.js';

export type { VisualizerContributes, VisualizerManifest } from './types/visualizer.js';

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
  WSGitRefsUpdatedData,
  GitRefsUpdatedChange,
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
  AgentExecutionProfileProvider,
  ClaudeExecutionProfileConfig,
  AgentExecutionProfileConfig,
  CreateAgentExecutionProfileRequest,
  UpdateAgentExecutionProfileRequest,
  UpdateProjectAgentProfileBindingRequest,
  AgentExecutionProfile,
  AgentExecutionProfileResponse,
  ProjectAgentProfileBinding,
  ProjectAgentProfileBindingResponse,
  ResolvedAgentExecutionProfile,
  ResolvedAgentExecutionProfileResponse,
  ThreadResolvedAgentProfileSnapshot,
} from './types/agent-execution-profiles.js';
export {
  agentExecutionProfileProviderSchema,
  claudeExecutionProfileConfigSchema,
  agentExecutionProfileConfigSchema,
  createAgentExecutionProfileSchema,
  updateAgentExecutionProfileSchema,
  updateProjectAgentProfileBindingSchema,
  toAgentExecutionProfileResponse,
  buildAgentExecutionProfileEnv,
} from './types/agent-execution-profiles.js';

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
  WSPipelineApprovalRequestedData,
  WSPipelineApprovalResolvedData,
} from './types/pipelines.js';

export type {
  WorkflowSource,
  WorkflowNodeRunStatus,
  WorkflowDiagnostic,
  WorkflowSummary,
  WorkflowGraphDto,
  WorkflowDefinitionResponse,
  WorkflowListResponse,
  WorkflowValidateRequest,
  WorkflowValidateResponse,
  WorkflowSaveRequest,
  WorkflowSaveResponse,
  WorkflowRunRequest,
  WorkflowRunResponse,
  WorkflowCancelResponse,
  WorkflowNodeRunState,
} from './types/workflows.js';
export { isErrorDiagnostic } from './types/workflows.js';

export type {
  AutomationSchedule,
  RunTriageStatus,
  Automation,
  AutomationRun,
  CreateAutomationRequest,
  UpdateAutomationRequest,
  InboxItem,
  InboxThread,
} from './types/automations.js';

export type { ThreadEventType, ThreadEvent, TurnOutcomeEventData } from './types/thread-events.js';

export type { ChangedFilesSummaryEventData } from './session-changed-files.js';
export {
  REMOTE_CONNECTOR_PROTOCOL_VERSION,
  REMOTE_CONNECTOR_PROTOCOL_VERSIONS,
  REMOTE_CONNECTOR_MAX_OUTPUT_BYTES,
  REMOTE_CONNECTOR_MAX_REQUEST_AGE_MS,
  REMOTE_CONNECTOR_MAX_REQUEST_LIFETIME_MS,
  REMOTE_CONNECTOR_MAX_CLOCK_SKEW_MS,
  REMOTE_CONNECTOR_PAIRING_TTL_MS,
  REMOTE_CONNECTOR_ENROLMENT_TTL_MS,
  REMOTE_CONNECTOR_TARGET_CONFIG_MAX_LIFETIME_MS,
  REMOTE_CONNECTOR_SIGNATURE_ALGORITHM,
  REMOTE_CONNECTOR_TARGET_SIGNATURE_DOMAIN,
  REMOTE_CONNECTOR_REQUEST_SIGNATURE_DOMAIN,
  REMOTE_CONNECTOR_APPROVAL_SIGNATURE_DOMAIN,
  connectorCapabilities,
  connectorCapabilitySchema,
  connectorHelloSchema,
  connectorNegotiationRequestSchema,
  connectorNegotiationResultSchema,
  connectorPairingRegistrationSchema,
  connectorPairingConfirmationSchema,
  credentialEnvelopeBindingSchema,
  credentialEnrolmentEnvelopeSchema,
  credentialMutationSchema,
  credentialMutationAcknowledgementSchema,
  remoteArgumentValueSchema,
  remoteArgumentDefinitionSchema,
  remoteCommandTokenSchema,
  remoteOperationSchema,
  remoteTargetConfigSchema,
  signedTargetConfigSchema,
  targetConfigUpdateSchema,
  targetConfigAcknowledgementSchema,
  remoteExecutionActorSchema,
  remoteProductionApprovalSchema,
  unsignedRemoteExecutionRequestSchema,
  remoteExecutionDigestPayloadSchema,
  remoteExecutionRequestSchema,
  remoteCancellationSchema,
  connectorErrorCodes,
  connectorErrorCodeSchema,
  remoteExecutionResultSchema,
  remoteExecutionAuditSchema,
  connectorHealthRequestSchema,
  connectorHealthResultSchema,
  connectorErrorResultSchema,
  connectorIpcRequestSchema,
  connectorIpcResponseSchema,
  canonicalJson,
  sha256Digest,
  createRemoteExecutionDigest,
  remoteExecutionSignaturePayload,
  remoteProductionApprovalSignaturePayload,
  createTargetConfigDigest,
  validateSignedTargetConfigEnvelope,
  targetConfigSignaturePayload,
  validateRemoteOperationArguments,
  assertEnvelopeBinding,
  credentialEnvelopeAdditionalData,
  negotiateConnectorProtocol,
  validateRemoteExecutionAgainstTarget,
} from './remote-connector-protocol.js';
export type {
  ConnectorCapability,
  ConnectorHello,
  ConnectorNegotiationRequest,
  ConnectorNegotiationResult,
  ConnectorPairingRegistration,
  ConnectorPairingConfirmation,
  CredentialEnvelopeBinding,
  CredentialEnrolmentEnvelope,
  CredentialMutation,
  CredentialMutationAcknowledgement,
  RemoteArgumentValue,
  RemoteArgumentDefinition,
  RemoteOperation,
  RemoteTargetConfig,
  SignedTargetConfig,
  TargetConfigUpdate,
  TargetConfigAcknowledgement,
  RemoteExecutionActor,
  RemoteProductionApproval,
  UnsignedRemoteExecutionRequest,
  RemoteExecutionDigestPayload,
  RemoteExecutionRequest,
  RemoteCancellation,
  ConnectorErrorCode,
  RemoteExecutionResult,
  RemoteExecutionAudit,
  ConnectorHealthRequest,
  ConnectorHealthResult,
  ConnectorErrorResult,
  ConnectorIpcRequest,
  ConnectorIpcResponse,
  ValidatedRemoteExecution,
} from './remote-connector-protocol.js';
export {
  collectSessionChanges,
  latestSessionChanges,
  toolCallFilePath,
  relativizePath,
  FILE_MUTATING_TOOLS,
} from './session-changed-files.js';

// ─── Projects ────────────────────────────────────────────

/** Fields a project PATCH accepts (`null` clears an optional setting). */
export interface ProjectUpdateFields {
  name?: string;
  path?: string;
  color?: string | null;
  followUpMode?: string;
  fastMode?: boolean;
  redirectChecks?: boolean;
  defaultProvider?: string | null;
  defaultModel?: string | null;
  defaultEffort?: string | null;
  defaultMode?: string | null;
  defaultPermissionMode?: string | null;
  defaultBranch?: string | null;
  urls?: string[] | null;
  systemPrompt?: string | null;
  launcherUrl?: string | null;
  defaultAgentTemplateId?: string | null;
  closed?: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color?: string;
  followUpMode?: FollowUpMode;
  /** Per-project default for Claude fast mode (speed). New threads inherit it. */
  fastMode?: boolean;
  /**
   * Claude agents are told to use `funny_run_checks` when they run a plain
   * check (`npx vitest`, `tsc`, …) through Bash. Absent means on.
   */
  redirectChecks?: boolean;
  defaultProvider?: AgentProvider;
  defaultModel?: AgentModel;
  /** Per-project reasoning level used for new threads when the selected model supports it. */
  defaultEffort?: EffortLevel;
  defaultMode?: ThreadMode;
  defaultPermissionMode?: PermissionMode;
  defaultBranch?: string;
  urls?: string[];
  systemPrompt?: string;
  launcherUrl?: string;
  defaultAgentTemplateId?: string;
  userId: string;
  sortOrder: number;
  /** When true, the project is hidden from the sidebar's main list and shown under "Closed projects". */
  closed?: boolean;
  createdAt: string;
  isTeamProject?: boolean;
  /** Name of the organization this project belongs to (set when listing org projects) */
  organizationName?: string;
  /** Per-user local path for shared projects (set by non-owner members) */
  localPath?: string;
  /** True when the user needs to configure their local directory for a shared project */
  needsSetup?: boolean;
  /**
   * The requesting user's role on this project (collaborator model). `'owner'`
   * for projects they own, otherwise their `project_members` role. Drives
   * client-side gating of project settings — owner/admin may edit project
   * config, plain members are read-only.
   */
  role?: 'owner' | 'admin' | 'member';
}

// ─── Designs ─────────────────────────────────────────────

export type DesignType = 'prototype' | 'slides' | 'template' | 'other';
export type DesignFidelity = 'wireframe' | 'high';

export interface Design {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  type: DesignType;
  fidelity: DesignFidelity | null;
  speakerNotes: boolean;
  folderPath: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Threads ─────────────────────────────────────────────
// Primitive unions live in ./primitives.js (re-exported above).
// The Thread interface lives in ./types/thread.js (re-exported above).

// Model type unions are derived from MODEL_REGISTRY — see ./models.ts
import type { ClaudeModel, CodexModel, GeminiModel, DeepAgentModel, AgentModel } from './models.js';
export type { ClaudeModel, CodexModel, GeminiModel, DeepAgentModel, AgentModel };

// ─── Agent Definitions ──────────────────────────────────

export interface AgentDefinition {
  /** Unique identifier for this agent role (e.g. 'reviewer', 'corrector'). */
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
  /**
   * Tools that should be allow-listed for this agent role.
   * When set, the agent can ONLY use these tools (in addition to anything
   * permitted by user-level "always allow" rules). Useful for read-only
   * roles like `reviewer` to harden the boundary at the SDK level instead
   * of trusting the system prompt.
   */
  allowedTools?: string[];
  /** Tools that should be disabled for this agent role. */
  disallowedTools?: string[];
}

// ─── Messages, background work and WebSocket events (split modules) ──
export type {
  CommentSource,
  CommentAuthor,
  ThreadComment,
  MessageRole,
  ImageAttachment,
  Message,
  ThreadWithMessages,
  PaginatedMessages,
  ToolCall,
} from './types/messages.js';
export { AUTO_RESUME_MESSAGE_AUTHOR } from './types/messages.js';
export type {
  WatcherStatus,
  Watcher,
  WSWatcherData,
  JobStatus,
  Job,
  JobLogChunk,
  WSJobData,
  ActivityStatus,
  ActivityOrigin,
  ActivityEffectType,
  ActivityEffect,
  ActivityResultRef,
  Activity,
  WSActivityUpdatedData,
  WSActivityRemovedData,
  WSActivityProgressData,
} from './types/background.js';
export type {
  WSInitData,
  WSMessageData,
  WSToolCallData,
  WSToolOutputData,
  WSCheckRunData,
  WSStatusData,
  WSResultData,
  WSErrorData,
  WSCompactBoundaryData,
  ContextBreakdownKind,
  ContextBreakdown,
  WSContextUsageData,
  WSCommandOutputData,
  WSCommandStatusData,
  WSAutomationRunStartedData,
  WSAutomationRunCompletedData,
  WSPtyDataData,
  WSPtyExitData,
  WSPtyErrorData,
  WSPtyEnvActivatedData,
  WSQueueUpdateData,
  WSWorkflowStepData,
  WSWorkflowStatusData,
  WSThreadCreatedData,
  WSCommentDeletedData,
  WSThreadUpdatedData,
  WSThreadDeletedData,
  WSThreadStageChangedData,
  WSRateLimitInfo,
  WSRateLimitData,
  AgentAccountInfo,
  AgentPlanUsageWindow,
  AgentPlanUsage,
  WSAgentAccountData,
  WSAutomationRunUpdatedData,
  WSThreadEventData,
  WSWorktreeSetupData,
  WSEvent,
  WSOrgMemberData,
  WSOrgInvitationData,
  WSWorktreeSetupCompleteData,
  WSCloneProgressData,
  WSEventType,
} from './types/ws-events.js';
import type { ImageAttachment } from './types/messages.js';

// ─── Startup Commands ────────────────────────────────────

export interface StartupCommand {
  id: string;
  projectId: string;
  label: string;
  command: string;
  /** Port the command serves on, for the preview. */
  port?: number;
  /** Env var the port is passed in. */
  portEnvVar?: string;
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
  designId?: string;
  agentTemplateId?: string;
  templateVariables?: Record<string, string>;
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
