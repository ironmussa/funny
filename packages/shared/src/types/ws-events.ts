// WebSocket event payloads and the `WSEvent` union (re-exported from `../types.js`).
import type { JsonObject } from '../json.js';
import type { PermissionMode, ThreadStage, ThreadStatus, WaitingReason } from '../primitives.js';
import type { TeamRole } from './auth.js';
import type {
  WSActivityProgressData,
  WSActivityRemovedData,
  WSActivityUpdatedData,
  WSJobData,
  WSWatcherData,
} from './background.js';
import type {
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
} from './browser-session.js';
import type { WSGitStatusData, WSGitRefsUpdatedData, WSGitWorkflowProgressData } from './git.js';
import type { ImageAttachment } from './messages.js';
import type {
  PendingPermissionRequest,
  PermissionApprovalCapability,
} from './permission-approvals.js';
import type {
  WSPipelineRunStartedData,
  WSPipelineStageUpdateData,
  WSPipelineRunCompletedData,
  WSPipelineApprovalRequestedData,
  WSPipelineApprovalResolvedData,
} from './pipelines.js';
import type {
  WSTestActionData,
  WSTestFrameData,
  WSTestOutputData,
  WSTestStatusData,
  WSTestConsoleData,
  WSTestNetworkData,
  WSTestErrorData,
} from './test.js';
import type { ThreadEvent } from './thread-events.js';
import type { WorkflowNodeRunState } from './workflows.js';

// ─── WebSocket Events ────────────────────────────────────

export interface WSInitData {
  tools: string[];
  cwd: string;
  model: string;
  // Slash commands the SDK reports for this session (names without leading
  // slash), e.g. ['compact', 'clear', 'context', ...]. Drives the client's
  // slash-command autocomplete and the send-boundary guard.
  slashCommands?: string[];
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

/** A `funny_run_checks` run started: where its progress file is. */
export interface WSCheckRunData {
  runId: string;
  kind: string;
  /** Absolute path of the test-progress / task-progress file. */
  path: string;
  /** `checkInputKey` of the tool call's input. */
  inputKey: string;
  startedAt: number;
}

export interface WSStatusData {
  status: ThreadStatus;
  waitingReason?: WaitingReason;
  permissionRequest?: { toolName: string; toolInput?: string };
  /** Provider-native request; unlike permissionRequest this is directly actionable. */
  pendingPermissionRequest?: PendingPermissionRequest;
  permissionApprovalCapability?: PermissionApprovalCapability;
  /** The live process disappeared while it owned a structured request. */
  permissionRecoveryReason?: import('./permission-approvals.js').PermissionRecoveryReason;
  permissionMode?: PermissionMode;
}

export interface WSResultData {
  status?: ThreadStatus;
  waitingReason?: WaitingReason;
  permissionRequest?: { toolName: string; toolInput?: string };
  pendingPermissionRequest?: PendingPermissionRequest;
  permissionApprovalCapability?: PermissionApprovalCapability;
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
  /** Context size AFTER compaction (0 when the SDK doesn't report it). */
  postTokens?: number;
  timestamp: string;
}

/** Row classification of a {@link ContextBreakdown} category (mirrors the Claude Agent SDK). */
export type ContextBreakdownKind = 'used' | 'free' | 'buffer' | 'deferred';

/**
 * Per-category context window breakdown — the data behind Claude Code's
 * `/context` report. Only the Claude SDK provider reports it; it is a
 * snapshot taken at the end of each turn.
 */
export interface ContextBreakdown {
  model: string;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories: {
    /** Stable row id (e.g. `messages`, `mcp_tools`); absent on older CLIs. */
    id?: string;
    name: string;
    tokens: number;
    kind: ContextBreakdownKind;
  }[];
  /** MCP tool tokens aggregated per server. */
  mcpServers: { name: string; tools: number; tokens: number }[];
  memoryFiles: { path: string; type: string; tokens: number }[];
  /** ISO timestamp of when the snapshot was taken. */
  capturedAt: string;
}

export interface WSContextUsageData {
  inputTokens: number;
  outputTokens: number;
  cumulativeInputTokens: number;
  /** Present on the end-of-turn snapshot from providers that report it (Claude SDK). */
  breakdown?: ContextBreakdown;
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
  /**
   * Terminal output bytes. The hot path (PTY → coalescer → WS) sends raw
   * UTF-8 bytes as Uint8Array so Socket.IO uses a binary frame instead of
   * JSON-escaping the string — this is the largest performance win for
   * heavy stdout (npm install, cat, yes). String form is still accepted
   * for restore/capture/adopt paths that don't go through the coalescer.
   */
  data: string | Uint8Array;
}

export interface WSPtyExitData {
  ptyId: string;
  exitCode: number;
}

export interface WSPtyErrorData {
  ptyId: string;
  error: string;
}

export interface WSPtyEnvActivatedData {
  ptyId: string;
  activations: Array<{ kind: 'python-venv' | 'node-version'; detail: string }>;
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
  output?: JsonObject;
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
  /** Forces clients to reload durable state after a recoverable stream gap. */
  resync?: boolean;
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

export interface WSRateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage';
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

export interface WSRateLimitData {
  info: WSRateLimitInfo;
}

/** The provider account a run is logged in with (Claude SDK `accountInfo()`). */
export interface AgentAccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  /** `firstParty` for an Anthropic login; Bedrock / Vertex / … otherwise. */
  apiProvider?: string;
}

/** One plan rate-limit window: `utilization` is 0-100, `resetsAt` ISO 8601. */
export interface AgentPlanUsageWindow {
  /** `five_hour`, `seven_day`, `seven_day_opus`, … or `model:<display name>`. */
  key: string;
  /** Server-supplied label (per-model windows only). */
  label?: string;
  utilization: number | null;
  resetsAt: string | null;
}

/** Claude.ai plan usage of the account (Claude SDK `/usage`). */
export interface AgentPlanUsage {
  windows: AgentPlanUsageWindow[];
  extraUsage?: {
    usedCredits: number | null;
    monthlyLimit: number | null;
    utilization: number | null;
    currency?: string | null;
  };
}

/**
 * The account a run uses, sent at session start and after every turn.
 * `profileId` / `profileName` name the funny execution profile
 * (CLAUDE_CONFIG_DIR); both null for the runner's default Claude login.
 * `usage` is absent when plan limits do not apply (API key, Bedrock, …) or the
 * request failed.
 */
export interface WSAgentAccountData {
  profileId: string | null;
  profileName: string | null;
  account: AgentAccountInfo;
  usage?: AgentPlanUsage;
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
  | { type: 'agent:check_run'; threadId: string; data: WSCheckRunData }
  | { type: 'agent:status'; threadId: string; data: WSStatusData }
  | { type: 'agent:result'; threadId: string; data: WSResultData }
  | { type: 'agent:error'; threadId: string; data: WSErrorData }
  | { type: 'agent:compact_boundary'; threadId: string; data: WSCompactBoundaryData }
  | { type: 'agent:context_usage'; threadId: string; data: WSContextUsageData }
  | { type: 'agent:rate_limit'; threadId: string; data: WSRateLimitData }
  | { type: 'agent:account'; threadId: string; data: WSAgentAccountData }
  | { type: 'command:output'; threadId: string; data: WSCommandOutputData }
  | { type: 'command:status'; threadId: string; data: WSCommandStatusData }
  | { type: 'automation:run_started'; threadId: string; data: WSAutomationRunStartedData }
  | { type: 'automation:run_completed'; threadId: string; data: WSAutomationRunCompletedData }
  | { type: 'automation:run_updated'; threadId: string; data: WSAutomationRunUpdatedData }
  | { type: 'watcher:created'; threadId: string; data: WSWatcherData }
  | { type: 'watcher:fired'; threadId: string; data: WSWatcherData }
  | { type: 'watcher:rescheduled'; threadId: string; data: WSWatcherData }
  | { type: 'watcher:completed'; threadId: string; data: WSWatcherData }
  | { type: 'watcher:cancelled'; threadId: string; data: WSWatcherData }
  | { type: 'job:created'; threadId: string; data: WSJobData }
  | { type: 'job:exited'; threadId: string; data: WSJobData }
  | { type: 'job:killed'; threadId: string; data: WSJobData }
  | { type: 'job:cancelled'; threadId: string; data: WSJobData }
  | { type: 'git:status'; threadId: string; data: WSGitStatusData }
  | { type: 'git:refs-updated'; threadId: string; data: WSGitRefsUpdatedData }
  | { type: 'pty:data'; threadId: string; data: WSPtyDataData }
  | { type: 'pty:exit'; threadId: string; data: WSPtyExitData }
  | { type: 'pty:error'; threadId: string; data: WSPtyErrorData }
  | { type: 'pty:env_activated'; threadId: string; data: WSPtyEnvActivatedData }
  | { type: 'thread:created'; threadId: string; data: WSThreadCreatedData }
  | { type: 'thread:deleted'; threadId: string; data: WSThreadDeletedData }
  | { type: 'thread:stage-changed'; threadId: string; data: WSThreadStageChangedData }
  | { type: 'thread:comment_deleted'; threadId: string; data: WSCommentDeletedData }
  | { type: 'thread:updated'; threadId: string; data: WSThreadUpdatedData }
  | { type: 'thread:queue_update'; threadId: string; data: WSQueueUpdateData }
  | { type: 'workflow:step'; threadId: string; data: WSWorkflowStepData }
  | { type: 'workflow:status'; threadId: string; data: WSWorkflowStatusData }
  | { type: 'workflow:node_state'; threadId: string; data: WorkflowNodeRunState }
  | { type: 'thread:event'; threadId: string; data: WSThreadEventData }
  | { type: 'git:workflow_progress'; threadId: string; data: WSGitWorkflowProgressData }
  | { type: 'worktree:setup'; threadId: string; data: WSWorktreeSetupData }
  | { type: 'worktree:setup_complete'; threadId: string; data: WSWorktreeSetupCompleteData }
  | { type: 'clone:progress'; threadId: string; data: WSCloneProgressData }
  | { type: 'activity:updated'; threadId: ''; data: WSActivityUpdatedData }
  | { type: 'activity:removed'; threadId: ''; data: WSActivityRemovedData }
  | { type: 'activity:progress'; threadId: ''; data: WSActivityProgressData }
  | { type: 'pipeline:run_started'; threadId: string; data: WSPipelineRunStartedData }
  | { type: 'pipeline:stage_update'; threadId: string; data: WSPipelineStageUpdateData }
  | { type: 'pipeline:run_completed'; threadId: string; data: WSPipelineRunCompletedData }
  | {
      type: 'pipeline:approval_requested';
      threadId: string;
      data: WSPipelineApprovalRequestedData;
    }
  | {
      type: 'pipeline:approval_resolved';
      threadId: string;
      data: WSPipelineApprovalResolvedData;
    }
  | { type: 'org:member_added'; threadId: ''; data: WSOrgMemberData }
  | { type: 'org:member_removed'; threadId: ''; data: WSOrgMemberData }
  | { type: 'org:invitation_received'; threadId: ''; data: WSOrgInvitationData }
  | { type: 'test:frame'; threadId: string; data: WSTestFrameData }
  | { type: 'test:output'; threadId: string; data: WSTestOutputData }
  | { type: 'test:status'; threadId: string; data: WSTestStatusData }
  | { type: 'test:console'; threadId: string; data: WSTestConsoleData }
  | { type: 'test:network'; threadId: string; data: WSTestNetworkData }
  | { type: 'test:error'; threadId: string; data: WSTestErrorData }
  | { type: 'test:action'; threadId: string; data: WSTestActionData }
  // ─── Browser annotator panel (CDP-driven Chromium sessions) ─────────────
  | { type: 'browser-session:open'; threadId: ''; data: WSBrowserSessionOpenData }
  | { type: 'browser-session:navigate'; threadId: ''; data: WSBrowserSessionNavigateData }
  | { type: 'browser-session:nav'; threadId: ''; data: WSBrowserSessionNavData }
  | { type: 'browser-session:input'; threadId: ''; data: WSBrowserSessionInputData }
  | { type: 'browser-session:inspect-at'; threadId: ''; data: WSBrowserSessionInspectAtData }
  | { type: 'browser-session:inspect-rect'; threadId: ''; data: WSBrowserSessionInspectRectData }
  | { type: 'browser-session:screenshot'; threadId: ''; data: WSBrowserSessionScreenshotData }
  | { type: 'browser-session:execute'; threadId: ''; data: WSBrowserSessionExecuteData }
  | { type: 'browser-session:heartbeat'; threadId: ''; data: WSBrowserSessionHeartbeatData }
  | { type: 'browser-session:close'; threadId: ''; data: WSBrowserSessionCloseData }
  | { type: 'browser-session:ready'; threadId: ''; data: WSBrowserSessionReadyData }
  | { type: 'browser-session:frame'; threadId: ''; data: WSBrowserSessionFrameData }
  | { type: 'browser-session:result'; threadId: ''; data: WSBrowserSessionResultData }
  | { type: 'browser-session:console'; threadId: ''; data: WSBrowserSessionConsoleData }
  | { type: 'browser-session:error'; threadId: ''; data: WSBrowserSessionErrorData }
  | { type: 'browser-session:closed'; threadId: ''; data: WSBrowserSessionClosedData }
  | {
      type: 'browser-session:agent-opened';
      threadId: '';
      data: WSBrowserSessionAgentOpenedData;
    }
  | { type: 'browser-session:viewport'; threadId: ''; data: WSBrowserSessionViewportData }
  | { type: 'browser-session:controller'; threadId: ''; data: WSBrowserSessionControllerData }
  | { type: 'browser-session:dialog'; threadId: ''; data: WSBrowserSessionDialogData }
  | { type: 'browser-session:pointer'; threadId: ''; data: WSBrowserSessionPointerData }
  | {
      type: 'browser-session:agent-action';
      threadId: '';
      data: WSBrowserSessionAgentActionData;
    }
  | { type: 'browser-session:navigated'; threadId: ''; data: WSBrowserSessionNavigatedData }
  | { type: 'browser-session:audio'; threadId: ''; data: WSBrowserSessionAudioData };

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
  /** `done` and `failed` are the clone's last event. */
  status?: 'running' | 'done' | 'failed';
  /** The created project, on the `done` event. */
  projectId?: string;
  error?: string;
}

export type WSEventType = WSEvent['type'];
