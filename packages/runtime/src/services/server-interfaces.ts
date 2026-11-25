/**
 * @domain subdomain: Shared Kernel
 * @domain type: port
 * @domain layer: domain
 *
 * Dependency-injection interfaces for the runtime.
 *
 * The runtime NEVER accesses the database directly. Instead, the server
 * injects concrete implementations of these interfaces at startup via
 * `RuntimeServiceProvider`. The implementations proxy over WebSocket
 * to the central server.
 *
 * Interfaces are split by responsibility (ISP).
 */

import type { JsonValue } from '@bufbuild/protobuf';
import type {
  PendingPermissionRequest,
  WSEvent,
  Project,
  UserProfile,
  UpdateProfileRequest,
  Watcher,
  Job,
  ResolvedAgentExecutionProfileResponse,
  ThreadWithMessages,
} from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import type { Result, ResultAsync } from 'neverthrow';

import type { pipelineRuns, pipelines, threads } from '../db/schema.js';

export interface RuntimeThreadRecord {
  id: string;
  projectId: string;
  userId: string;
  sessionId: string | null;
  isScratch?: boolean;
  /** `threads.read_only`: 1 when the agent may only read. */
  readOnly?: number | boolean | null;
  /** Who started it (`threads.source`): `factory` for the issue factory's threads. */
  source?: string | null;
  status?: string;
  stage?: string;
  mode?: string;
  model?: string;
  provider?: string;
  permissionMode?: string;
  branch?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
  mergedAt?: string | null;
  cost?: number | null;
  title?: string | null;
  initialPrompt?: string | null;
  /** `threads.runtime`: `local` or `sandbox`. */
  runtime?: string | null;
  /** SDK-reported tools (JSON `string[]`). */
  initTools?: string | null;
  initCwd?: string | null;
  initSlashCommands?: string | null;
  agentProfileId?: string | null;
  agentProfileName?: string | null;
  agentProfileProvider?: string | null;
  agentTemplateId?: string | null;
  /** The template's filled variable values: the column's JSON text, or already parsed. */
  templateVariables?: string | Record<string, string> | null;
  contextRecoveryReason?: string | null;
  fileCheckpointingEnabled?: number | boolean | null;
  completedAt?: string | null;
}

/** A thread record with a window of its messages (`data:get_thread_with_messages`). */
export type RuntimeThreadWithMessages = RuntimeThreadRecord &
  Pick<
    ThreadWithMessages,
    'hasMore' | 'hasMoreAfter' | 'total' | 'windowStart' | 'waitingReason' | 'pendingPermission'
  > & { messages: any[] };

/** A `threads` row the runtime creates (`data:create_thread`). */
export type RuntimeThreadInsert = typeof threads.$inferInsert;

/** Thread fields the runtime writes (`data:update_thread`): columns of the `threads` table. */
export type RuntimeThreadUpdate = Partial<RuntimeThreadInsert>;

/**
 * Payload of a thread event: a protobuf `Struct` on the wire (`SaveThreadEvent.data`),
 * stored as JSON. Fields left `undefined` are dropped when it is sent.
 */
export type ThreadEventData = { readonly [key: string]: JsonValue | undefined };

/** Pipeline fields the runtime writes: columns of the `pipelines` table. */
export type PipelineUpdate = Partial<typeof pipelines.$inferInsert>;

/** Pipeline run fields the runtime writes: columns of the `pipeline_runs` table. */
export type PipelineRunUpdate = Partial<typeof pipelineRuns.$inferInsert>;

// ── Thread query / mutation ────────────────────────────────────

export interface IThreadQuery {
  getThread(id: string): RuntimeThreadRecord | undefined | Promise<RuntimeThreadRecord | undefined>;
  updateThread(id: string, updates: RuntimeThreadUpdate): void | Promise<void>;
  createPendingPermissionRequest?(request: PendingPermissionRequest): void | Promise<void>;
  /** Resolve only an active durable request. `false` means stale. */
  resolvePendingPermissionRequest?(
    requestId: string,
    decision: import('@funny/shared').PermissionDecision,
  ): boolean | void | Promise<boolean | void>;
  expirePendingPermissionRequest?(requestId: string): void | Promise<void>;
  getThreadWithMessages(
    id: string,
    messageLimit?: number,
    opts?: { messageProgress?: number },
  ): RuntimeThreadWithMessages | null | Promise<RuntimeThreadWithMessages | null>;
}

// ── Message repository ──────────────────────────────────────────

export interface IMessageRepository {
  insertMessage(data: {
    threadId: string;
    role: string;
    content: string;
    images?: string | null;
    model?: string | null;
    permissionMode?: string | null;
    effort?: string | null;
    author?: string | null;
    timestamp?: string | null;
  }): string | Promise<string>;
  updateMessage(
    id: string,
    data: string | { content: string; images?: string | null },
  ): void | Promise<void>;
  /** Truncate the thread by removing every message strictly after the
   *  anchor (used by Rewind code to here). Returns the deleted count. */
  deleteMessagesAfter(threadId: string, anchorMessageId: string): Promise<number>;
}

// ── Tool call repository ────────────────────────────────────────

export interface IToolCallRepository {
  insertToolCall(data: {
    messageId: string;
    name: string;
    input: string;
    author?: string | null;
    parentToolCallId?: string | null;
  }): string | Promise<string>;
  updateToolCallOutput(id: string, output: string): void | Promise<void>;
  findToolCall(
    messageId: string,
    name: string,
    input: string,
  ): { id: string } | undefined | Promise<{ id: string } | undefined>;
  getToolCall(id: string):
    | { id: string; name: string; input: string | null; output?: string | null }
    | undefined
    | Promise<
        | {
            id: string;
            name: string;
            input: string | null;
            output?: string | null;
          }
        | undefined
      >;
}

// ── Combined interface (backward-compatible) ────────────────────

export interface IThreadManager extends IThreadQuery, IMessageRepository, IToolCallRepository {}

// ── WebSocket broker ────────────────────────────────────────────

export interface IWSBroker {
  emit(event: WSEvent): void;
  emitToUser(userId: string, event: WSEvent): void;
}

// ── Project repository ──────────────────────────────────────────

export interface IProjectRepository {
  listProjects(userId: string): Promise<Project[]>;
  listProjectsByOrg(orgId: string): Promise<Project[]>;
  isProjectInOrg(projectId: string, orgId: string): Promise<boolean>;
  getProject(id: string): Promise<Project | undefined>;
  projectNameExists(name: string, userId: string, orgId?: string | null): Promise<boolean>;
  createProject(
    name: string,
    path: string,
    userId: string,
    orgId?: string | null,
  ): Promise<Result<Project, DomainError>>;
  updateProject(
    id: string,
    fields: {
      name?: string;
      color?: string | null;
      followUpMode?: string;
      defaultProvider?: string | null;
      defaultModel?: string | null;
      defaultMode?: string | null;
      defaultPermissionMode?: string | null;
      defaultBranch?: string | null;
      urls?: string[] | null;
      systemPrompt?: string | null;
      launcherUrl?: string | null;
    },
  ): Promise<Result<Project, DomainError>>;
  deleteProject(id: string): Promise<void>;
  addProjectToOrg(projectId: string, orgId: string): Promise<void>;
  getMemberLocalPath(projectId: string, userId: string): Promise<string | null>;
  resolveProjectPath(projectId: string, userId: string): Promise<Result<string, DomainError>>;
  reorderProjects(userId: string, projectIds: string[]): Promise<Result<void, DomainError>>;
}

// ── Thread repository (full CRUD beyond IThreadQuery) ───────────

export interface IThreadRepository extends IThreadQuery, IMessageRepository, IToolCallRepository {
  listThreads(opts: {
    projectId?: string;
    userId: string;
    includeArchived?: boolean;
    isScratch?: boolean | 'exclude';
    limit?: number;
    offset?: number;
  }): Promise<{ threads: any[]; total: number }>;
  listArchivedThreads(projectId: string, userId: string): Promise<any[]>;
  getThreadByExternalRequestId(externalRequestId: string): Promise<any | undefined>;
  getThreadBySessionId(sessionId: string): Promise<any | undefined>;
  createThread(data: RuntimeThreadInsert): Promise<any>;
  deleteThread(id: string): Promise<void>;
  markStaleThreadsInterrupted(): Promise<void>;
  markStaleExternalThreadsStopped(): Promise<void>;
  markAndListStaleThreads(runnerId: string): Promise<any[]>;
  getThreadMessages(opts: {
    threadId: string;
    cursor?: string;
    limit: number;
    direction?: 'before' | 'after';
  }): Promise<{
    messages: any[];
    hasMore: boolean;
    hasMoreAfter?: boolean;
    total?: number;
    windowStart?: number;
    leadingUserMessage?: any;
  }>;
  insertComment(data: {
    threadId: string;
    userId: string;
    content: string;
    toolCallId?: string | null;
  }): Promise<any>;
  listComments(threadId: string): Promise<any[]>;
  deleteComment(id: string): Promise<void>;
  getCommentCounts(threadIds: string[]): Promise<Record<string, number>>;
  searchThreadIdsByContent(opts: {
    query: string;
    projectId?: string;
    userId: string;
  }): Promise<Map<string, string>>;
  findLastUnansweredInteractiveToolCall(threadId: string): Promise<any | undefined>;
}

// ── Pipeline repository ─────────────────────────────────────────

export interface IPipelineRepository {
  getPipelineForProject(projectId: string): Promise<any | null>;
  createPipeline(data: {
    projectId: string;
    userId: string;
    name: string;
    reviewModel?: string;
    fixModel?: string;
    maxIterations?: number;
    precommitFixEnabled?: boolean;
    precommitFixModel?: string;
    precommitFixMaxIterations?: number;
    reviewerPrompt?: string;
    correctorPrompt?: string;
    precommitFixerPrompt?: string;
    commitMessagePrompt?: string;
    testEnabled?: boolean;
    testCommand?: string;
    testFixEnabled?: boolean;
    testFixModel?: string;
    testFixMaxIterations?: number;
    testFixerPrompt?: string;
  }): Promise<string>;
  getPipelineById(id: string): Promise<any | undefined>;
  getPipelinesByProject(projectId: string): Promise<any[]>;
  updatePipeline(id: string, updates: PipelineUpdate): Promise<void>;
  deletePipeline(id: string): Promise<void>;
  createRun(data: {
    pipelineId: string;
    threadId: string;
    maxIterations: number;
    commitSha?: string;
  }): Promise<string>;
  updateRun(id: string, updates: PipelineRunUpdate): Promise<void>;
  getRunById(id: string): Promise<any | undefined>;
  getRunsForThread(threadId: string): Promise<any[]>;
}

// ── Profile service ─────────────────────────────────────────────

export interface IProfileService {
  getProfile(userId: string): Promise<UserProfile | null>;
  getProviderKey(userId: string, provider: string): Promise<string | null>;
  /** `projectId` lets a project-level token override the user's (project-runner-binding). */
  getGithubToken(userId: string, projectId?: string): Promise<string | null>;
  getAssemblyaiApiKey(userId: string): Promise<string | null>;
  getMinimaxApiKey(userId: string): Promise<string | null>;
  getGitIdentity(userId: string): Promise<{ name: string; email: string } | null>;
  isSetupCompleted(userId: string): Promise<boolean>;
  updateProfile(userId: string, data: UpdateProfileRequest): Promise<UserProfile>;
}

// ── Agent execution profiles ────────────────────────────────────

export interface IAgentExecutionProfileService {
  resolveEffectiveProfile(
    projectId: string,
    userId: string,
  ): Promise<ResolvedAgentExecutionProfileResponse>;
}

// ── Analytics service ───────────────────────────────────────────

export interface IAnalyticsService {
  getOverview(params: {
    userId: string;
    projectId?: string;
    timeRange?: string;
    offsetMinutes?: number;
  }): Promise<any>;
  getTimeline(params: {
    userId: string;
    projectId?: string;
    timeRange?: string;
    groupBy?: string;
    offsetMinutes?: number;
  }): Promise<any>;
}

// ── Search service ──────────────────────────────────────────────

export interface ISearchService {
  searchThreadIdsByContent(opts: {
    query: string;
    projectId?: string;
    userId: string;
  }): Promise<Map<string, string>>;
}

// ── Startup commands service ────────────────────────────────────

export interface IStartupCommandsService {
  listCommands(projectId: string): Promise<any[]>;
  createCommand(data: { projectId: string; label: string; command: string }): Promise<any>;
  // Security CR-6: updateCommand/deleteCommand require projectId so the
  // server-side repo can scope the SQL `WHERE` by parent project — prevents
  // cross-project tampering on a guessed cmdId.
  updateCommand(
    cmdId: string,
    projectId: string,
    data: {
      label: string;
      command: string;
      port?: number;
      portEnvVar?: string;
    },
  ): Promise<void>;
  deleteCommand(cmdId: string, projectId: string): Promise<void>;
  getCommand(cmdId: string, projectId: string): Promise<any | undefined>;
}

// ── Thread event service ────────────────────────────────────────

export interface IThreadEventService {
  createThreadEvent(event: {
    id?: string;
    threadId: string;
    type: string;
    data: ThreadEventData;
    timestamp?: number;
  }): Promise<void>;
  saveThreadEvent(threadId: string, type: string, data: ThreadEventData): Promise<void>;
  getThreadEvents(threadId: string): Promise<any[]>;
  deleteThreadEvents(threadId: string): Promise<void>;
}

// ── Message queue service ───────────────────────────────────────

/** A follow-up message to queue for a thread (`data:enqueue_message`). */
export interface EnqueueMessageInput {
  content: string;
  provider?: string;
  model?: string;
  permissionMode?: string;
  images?: string;
  allowedTools?: string;
  disallowedTools?: string;
  fileReferences?: string;
}

export interface IMessageQueueService {
  enqueue(
    threadId: string,
    entry: EnqueueMessageInput,
  ): Promise<{
    id: string;
    threadId: string;
    content: string;
    provider: string | null;
    model: string | null;
    permissionMode: string | null;
    images: string | null;
    allowedTools: string | null;
    disallowedTools: string | null;
    fileReferences: string | null;
    sortOrder: number;
    createdAt: string;
  }>;
  peek(threadId: string): Promise<any | null>;
  dequeue(threadId: string): Promise<any | null>;
  cancel(messageId: string): Promise<boolean>;
  update(messageId: string, content: string): Promise<any | null>;
  listQueue(threadId: string): Promise<any[]>;
  queueCount(threadId: string): Promise<number>;
  clearQueue(threadId: string): Promise<void>;
}

// ── MCP OAuth service ───────────────────────────────────────────

export interface IMcpOauthService {
  startOAuthFlow(
    serverName: string,
    serverUrl: string,
    projectPath: string,
    callbackBaseUrl: string,
  ): ResultAsync<{ authUrl: string; state: string }, DomainError>;
  handleOAuthCallback(
    code: string,
    state: string,
  ): Promise<{ serverName: string; success: boolean; error?: string }>;
  /** Upsert an OAuth token in the database (delete existing + insert). */
  upsertToken(data: {
    serverName: string;
    projectPath: string;
    serverUrl: string;
    accessToken: string;
    refreshToken?: string | null;
    tokenType: string;
    expiresAt?: string | null;
    scope?: string | null;
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string | null;
  }): Promise<void>;
}

// ── Stage history ───────────────────────────────────────────────

export interface IStageHistoryRepository {
  recordStageChange(data: { threadId: string; fromStage: string; toStage: string }): Promise<void>;
}

// ── Agent watchers (deferred-wake "snooze") ─────────────────────

export interface IWatcherRepository {
  insertWatcher(row: Watcher): Promise<void>;
  getWatcher(id: string): Promise<Watcher | undefined>;
  getLiveWatcherByThreadKey(threadId: string, key: string): Promise<Watcher | undefined>;
  /** Pending watchers for this runner's user — used to re-arm the scanner on boot. */
  listPendingWatchers(): Promise<Watcher[]>;
  /** Pending watchers for this runner's user whose `nextWakeAt <= now`. */
  listDueWatchers(now: number): Promise<Watcher[]>;
  listWatchersByUser(userId: string): Promise<Watcher[]>;
  /** Resolves false when a status in `patch` is not a legal transition from the stored one. */
  updateWatcher(
    id: string,
    patch: Partial<Watcher>,
    /** Apply only while the watcher's `nextWakeAt` still equals this. */
    expect?: { expectedNextWakeAt?: number },
  ): Promise<boolean>;
  deleteWatchersByThread(threadId: string): Promise<void>;
}

// ── Agent jobs (funny-owned detached background processes) ───────

export interface IJobRepository {
  insertJob(row: Job): Promise<void>;
  getJob(id: string): Promise<Job | undefined>;
  /** Running jobs for this runner's user — polled by the scanner for completion. */
  listRunningJobs(): Promise<Job[]>;
  listJobsByUser(userId: string): Promise<Job[]>;
  /** Resolves false when a status in `patch` is not a legal transition from the stored one. */
  updateJob(id: string, patch: Partial<Job>): Promise<boolean>;
  deleteJobsByThread(threadId: string): Promise<void>;
}
