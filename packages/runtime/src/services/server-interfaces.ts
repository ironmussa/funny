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

import type {
  WSEvent,
  Project,
  Thread,
  UserProfile,
  UpdateProfileRequest,
  FollowUpMode,
} from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import type { Result } from 'neverthrow';

// ── Thread query / mutation ────────────────────────────────────

export interface IThreadQuery {
  getThread(
    id: string,
  ):
    | { sessionId: string | null; [key: string]: any }
    | undefined
    | Promise<{ sessionId: string | null; [key: string]: any } | undefined>;
  updateThread(id: string, updates: Record<string, any>): void | Promise<void>;
  getThreadWithMessages(
    id: string,
  ):
    | { messages: any[]; [key: string]: any }
    | null
    | Promise<{ messages: any[]; [key: string]: any } | null>;
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
    author?: string | null;
  }): string | Promise<string>;
  updateMessage(id: string, content: string): void | Promise<void>;
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
  getToolCall(
    id: string,
  ):
    | { id: string; name: string; input: string | null; output?: string | null }
    | undefined
    | Promise<
        { id: string; name: string; input: string | null; output?: string | null } | undefined
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

export interface IThreadRepository extends IThreadQuery {
  listThreads(opts: {
    projectId?: string;
    userId: string;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ threads: any[]; total: number }>;
  listArchivedThreads(projectId: string, userId: string): Promise<any[]>;
  getThreadByExternalRequestId(externalRequestId: string): Promise<any | undefined>;
  createThread(data: Record<string, any>): Promise<any>;
  deleteThread(id: string): Promise<void>;
  markStaleThreadsInterrupted(): Promise<void>;
  markStaleExternalThreadsStopped(): Promise<void>;
  getThreadMessages(threadId: string): Promise<any[]>;
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

// ── Automation repository ───────────────────────────────────────

export interface IAutomationRepository {
  listAutomations(projectId?: string, userId?: string): Promise<any[]>;
  getAutomation(id: string): Promise<any | undefined>;
  /** Raw DB insert — no scheduler hooks. Use createAutomation for full flow. */
  insertAutomation(data: {
    id: string;
    projectId: string;
    userId: string;
    name: string;
    prompt: string;
    schedule: string;
    model: string;
    mode: string;
    permissionMode: string;
    enabled: number;
    maxRunHistory: number;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  /** Full create with scheduler notification (implemented by runtime). */
  createAutomation(data: {
    projectId: string;
    name: string;
    prompt: string;
    schedule: string;
    model?: string;
    permissionMode?: string;
    userId?: string;
  }): Promise<any>;
  /** Raw DB update — no scheduler hooks. */
  updateAutomationRow(id: string, updates: Record<string, any>): Promise<void>;
  /** Full update with scheduler notification (implemented by runtime). */
  updateAutomation(id: string, updates: Record<string, any>): Promise<void>;
  /** Raw DB delete — no scheduler hooks. */
  deleteAutomationRow(id: string): Promise<void>;
  /** Full delete with scheduler notification (implemented by runtime). */
  deleteAutomation(id: string): Promise<void>;
  createRun(data: {
    id: string;
    automationId: string;
    threadId: string;
    status: string;
    triageStatus: string;
    startedAt: string;
  }): Promise<void>;
  updateRun(id: string, updates: Record<string, any>): Promise<void>;
  listRuns(automationId: string): Promise<any[]>;
  listRunningRuns(): Promise<any[]>;
  getRunByThreadId(threadId: string): Promise<any | undefined>;
  listPendingReviewRuns(projectId?: string): Promise<any[]>;
  listInboxRuns(options?: { projectId?: string; triageStatus?: string }): Promise<any[]>;
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
  updatePipeline(id: string, updates: Record<string, unknown>): Promise<void>;
  deletePipeline(id: string): Promise<void>;
  createRun(data: {
    pipelineId: string;
    threadId: string;
    maxIterations: number;
    commitSha?: string;
  }): Promise<string>;
  updateRun(id: string, updates: Record<string, unknown>): Promise<void>;
  getRunById(id: string): Promise<any | undefined>;
  getRunsForThread(threadId: string): Promise<any[]>;
}

// ── Profile service ─────────────────────────────────────────────

export interface IProfileService {
  getProfile(userId: string): Promise<UserProfile | null>;
  getProviderKey(userId: string, provider: string): Promise<string | null>;
  getGithubToken(userId: string): Promise<string | null>;
  getAssemblyaiApiKey(userId: string): Promise<string | null>;
  getMinimaxApiKey(userId: string): Promise<string | null>;
  getGitIdentity(userId: string): Promise<{ name: string; email: string } | null>;
  isSetupCompleted(userId: string): Promise<boolean>;
  updateProfile(userId: string, data: UpdateProfileRequest): Promise<UserProfile>;
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
  updateCommand(
    cmdId: string,
    data: { label: string; command: string; port?: number; portEnvVar?: string },
  ): Promise<void>;
  deleteCommand(cmdId: string): Promise<void>;
  getCommand(cmdId: string): Promise<any | undefined>;
}

// ── Thread event service ────────────────────────────────────────

export interface IThreadEventService {
  createThreadEvent(event: {
    id?: string;
    threadId: string;
    type: string;
    data: Record<string, unknown>;
    timestamp?: number;
  }): Promise<void>;
  saveThreadEvent(threadId: string, type: string, data: Record<string, unknown>): Promise<void>;
  getThreadEvents(threadId: string): Promise<any[]>;
  deleteThreadEvents(threadId: string): Promise<void>;
}

// ── Message queue service ───────────────────────────────────────

export interface IMessageQueueService {
  enqueue(
    threadId: string,
    entry: {
      content: string;
      provider?: string;
      model?: string;
      permissionMode?: string;
      images?: string;
      allowedTools?: string;
      disallowedTools?: string;
      fileReferences?: string;
    },
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
  ): Promise<{ authUrl: string; state: string }>;
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

// ── Arc repository ──────────────────────────────────────────────

export interface IArcRepository {
  getArc(
    id: string,
  ): Promise<
    { id: string; projectId: string; userId: string; name: string; createdAt: string } | undefined
  >;
}
