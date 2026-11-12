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
  Automation,
  AutomationRun,
  InboxItem,
  Pipeline,
  PaginatedMessages,
  PaginatedThreadsResponse,
  PermissionMode,
  PipelineRun,
  RunTriageStatus,
  Thread,
  ThreadStage,
  ThreadStatus,
  ThreadWithMessages,
} from '@funny/shared';
import type {
  CreateAutomationRequest,
  UpdateAutomationRequest,
} from '@funny/shared/contracts/automations';
import type { QueryOf } from '@funny/shared/contracts/endpoint';
import type {
  CreatePipelineRequest,
  UpdatePipelineRequest,
} from '@funny/shared/contracts/pipelines';
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

export interface ApiPorts {
  automations: AutomationsPort;
  pipelines: PipelinesPort;
  threads: ThreadsPort;
  threadAccess: ThreadAccessPort;
}
