/**
 * What the procedures need from the server. The server implements these on
 * top of its repositories and services (`packages/server/src/trpc/ports/`);
 * this package only sees the shapes, so `AppRouter` never drags server
 * modules into a client's typecheck.
 *
 * Each method answers for one user and fails with the status its REST route
 * answers, so both paths behave the same while they coexist.
 */

import type {
  AgentExecutionProfileResponse,
  AgentTemplate,
  Automation,
  AutomationRun,
  CreateAgentExecutionProfileRequest,
  InboxItem,
  Job,
  Pipeline,
  PaginatedMessages,
  PaginatedThreadsResponse,
  PermissionMode,
  PipelineRun,
  ProjectAgentProfileBindingResponse,
  RunTriageStatus,
  Thread,
  ThreadStage,
  ThreadStatus,
  ThreadWithMessages,
  UpdateAgentExecutionProfileRequest,
  UpdateProfileRequest,
  UserProfile,
  Watcher,
} from '@funny/shared';
import type { Capability } from '@funny/shared/auth/roles';
import type {
  AgentTemplateBody,
  UpdateAgentTemplateBody,
} from '@funny/shared/contracts/agent-templates';
import type {
  CreateAutomationRequest,
  UpdateAutomationRequest,
} from '@funny/shared/contracts/automations';
import type { QueryOf } from '@funny/shared/contracts/endpoint';
import type {
  CreatePipelineRequest,
  UpdatePipelineRequest,
} from '@funny/shared/contracts/pipelines';
import type { ProfileResponse } from '@funny/shared/contracts/profile';
import type { SmtpSettingsRequest, SmtpSettingsResponse } from '@funny/shared/contracts/settings';
import type {
  ArchivedThreadsResponse,
  MessageSearchResult,
  ThreadPatchRequest,
  threadsContract,
} from '@funny/shared/contracts/threads';
import type { Result } from 'neverthrow';

import type { ApiFailure } from './failure.js';

export type PortResult<T> = Promise<Result<T, ApiFailure>>;

type Ok = { ok: true };

export interface AutomationsPort {
  inbox(
    userId: string,
    query: { projectId?: string; triageStatus?: string },
  ): PortResult<InboxItem[]>;
  list(userId: string, query: { projectId?: string }): PortResult<Automation[]>;
  get(userId: string, id: string): PortResult<Automation>;
  create(userId: string, data: CreateAutomationRequest): PortResult<Automation>;
  update(userId: string, id: string, data: UpdateAutomationRequest): PortResult<Automation>;
  remove(userId: string, id: string): PortResult<Ok>;
  trigger(userId: string, id: string): PortResult<Ok & { runId: string; threadId: string }>;
  runs(userId: string, id: string): PortResult<AutomationRun[]>;
  triageRun(userId: string, runId: string, triageStatus: RunTriageStatus): PortResult<Ok>;
}

export interface PipelinesPort {
  list(userId: string, projectId: string): PortResult<Pipeline[]>;
  get(userId: string, id: string): PortResult<Pipeline>;
  create(userId: string, data: CreatePipelineRequest): PortResult<Pipeline>;
  update(userId: string, id: string, data: UpdatePipelineRequest): PortResult<Pipeline>;
  remove(userId: string, id: string): PortResult<Ok>;
  /** Empty for a thread the caller does not own. */
  runsForThread(userId: string, threadId: string): PortResult<PipelineRun[]>;
}

type ThreadQuery<K extends keyof typeof threadsContract> = QueryOf<(typeof threadsContract)[K]>;

/** Who is calling: the user and the organization the session is acting in. */
export interface ApiCaller {
  userId: string;
  organizationId: string | null;
}

/**
 * The `/api/threads` operations the server answers from its own DB. Writes
 * take the thread `threadProcedure` already loaded and authorized; reads of one
 * thread's messages run after a `view` check.
 */
export interface ThreadsPort {
  list(caller: ApiCaller, query: ThreadQuery<'list'>): PortResult<PaginatedThreadsResponse>;
  scratch(userId: string, query: ThreadQuery<'scratch'>): PortResult<PaginatedThreadsResponse>;
  archived(userId: string, query: ThreadQuery<'archived'>): PortResult<ArchivedThreadsResponse>;
  /** Authorizes `view` itself, on the row it reads (hot path: one query). */
  get(userId: string, id: string, query: ThreadQuery<'get'>): PortResult<ThreadWithMessages>;
  messages(threadId: string, query: ThreadQuery<'messages'>): PortResult<PaginatedMessages>;
  searchMessages(
    threadId: string,
    query: ThreadQuery<'searchMessages'>,
  ): PortResult<{ results: MessageSearchResult[] }>;
  searchContent(
    userId: string,
    query: ThreadQuery<'searchContent'>,
  ): PortResult<{ threadIds: string[]; snippets: Record<string, string> }>;
  update(userId: string, thread: Thread, data: ThreadPatchRequest): PortResult<Thread>;
  setPermissionMode(userId: string, threadId: string, mode: PermissionMode): PortResult<Thread>;
  setStatus(
    userId: string,
    threadId: string,
    value: ThreadStatus,
    reason?: string,
  ): PortResult<Thread>;
  setStage(userId: string, thread: Thread, value: ThreadStage, reason?: string): PortResult<Thread>;
}

export type ThreadAccessLevel = 'view' | 'owner' | 'steer';

/**
 * The server's per-thread access decision (`middleware/thread-access.ts`), the
 * same one its REST routes use. `null` means "404 Thread not found", both for a
 * missing thread and for one the caller may not access (existence-hiding).
 */
export interface ThreadAccessPort {
  authorize(level: ThreadAccessLevel, threadId: string, userId: string): Promise<Thread | null>;
}

export interface ProfilePort {
  get(userId: string): PortResult<ProfileResponse>;
  update(userId: string, data: UpdateProfileRequest): PortResult<UserProfile>;
  /** A short-lived AssemblyAI streaming token; the API key stays on the server. */
  transcribeToken(userId: string): PortResult<{ token: string }>;
  setupCompleted(userId: string): PortResult<{ setupCompleted: boolean }>;
  runnerInviteToken(userId: string): PortResult<{ token: string }>;
  rotateRunnerInviteToken(userId: string): PortResult<{ token: string }>;
}

export interface SettingsPort {
  listAgentProfiles(userId: string): PortResult<{ profiles: AgentExecutionProfileResponse[] }>;
  createAgentProfile(
    userId: string,
    data: CreateAgentExecutionProfileRequest,
  ): PortResult<AgentExecutionProfileResponse>;
  updateAgentProfile(
    userId: string,
    id: string,
    data: UpdateAgentExecutionProfileRequest,
  ): PortResult<AgentExecutionProfileResponse>;
  deleteAgentProfile(userId: string, id: string): PortResult<Ok>;
  /** The caller's binding on a project `projectProcedure('view')` already authorized. */
  getProjectBinding(
    userId: string,
    projectId: string,
  ): PortResult<ProjectAgentProfileBindingResponse>;
  setProjectBinding(
    userId: string,
    projectId: string,
    profileId: string | null,
  ): PortResult<ProjectAgentProfileBindingResponse>;
  /** Instance-level, admin only (`adminProcedure`). */
  getSmtp(): PortResult<SmtpSettingsResponse>;
  saveSmtp(data: SmtpSettingsRequest): PortResult<Ok>;
  testSmtp(): PortResult<Ok & { sentTo: string }>;
}

export interface AgentTemplatesPort {
  /** The caller's own templates and every shared one, newest first. */
  list(userId: string): PortResult<AgentTemplate[]>;
  /** Thread count per template, over the caller's threads. */
  usageStats(userId: string): PortResult<Record<string, number>>;
  /** A built-in, own or shared template; anyone else's private one looks absent (404). */
  get(userId: string, id: string): PortResult<AgentTemplate>;
  create(userId: string, data: AgentTemplateBody): PortResult<AgentTemplate>;
  /** Runs after `authorizeWrite`. */
  update(userId: string, id: string, data: UpdateAgentTemplateBody): PortResult<AgentTemplate>;
  /** Runs after `authorizeWrite`. */
  remove(userId: string, id: string): PortResult<Ok>;
  /** A private copy of a built-in, own or shared template. */
  duplicate(userId: string, id: string): PortResult<AgentTemplate>;
  /** Only the owner writes: 404 when missing, 403 when someone else's. */
  authorizeWrite(userId: string, id: string): Promise<ApiFailure | null>;
}

export interface WatchersPort {
  list(userId: string): PortResult<Watcher[]>;
  /** Stops a live watcher of the caller (404 otherwise); terminal ones stay as they are. */
  cancel(userId: string, id: string): PortResult<Watcher>;
}

export interface JobsPort {
  /** Cancel and log reads stay REST: the runner owns the process and the logfile. */
  list(userId: string): PortResult<Job[]>;
}

/** The server's authorization decisions that are not about one thread. */
export interface AuthzPort {
  /**
   * The project decision of the REST `requireProjectAccess`: `null` when the
   * caller holds `capability`, else 404 (no role: the project looks absent) or 403.
   */
  projectAccess(
    capability: Capability,
    projectId: string,
    userId: string,
  ): Promise<ApiFailure | null>;
  /** Records a refused admin-only call, as the REST `requireAdmin` audits it. */
  adminRefused(userId: string, path: string, role: string | null): void;
}

export interface ApiPorts {
  automations: AutomationsPort;
  pipelines: PipelinesPort;
  threads: ThreadsPort;
  profile: ProfilePort;
  settings: SettingsPort;
  agentTemplates: AgentTemplatesPort;
  watchers: WatchersPort;
  jobs: JobsPort;
  threadAccess: ThreadAccessPort;
  authz: AuthzPort;
}
