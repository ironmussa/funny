/**
 * `threads` rows → the `Thread` the HTTP contract declares
 * (`@funny/shared/contracts/threads`).
 *
 * The repositories return raw rows (integer flags, nullable columns, JSON
 * text) because the runner data channel and the server's own services read
 * them that way. HTTP responses go through here instead, so the client gets
 * booleans, `''` for a scratch thread's project, absent optional fields, and
 * parsed template variables.
 */

import type {
  AgentModel,
  AgentProvider,
  PermissionMode,
  Thread,
  ThreadMode,
  ThreadRuntime,
  ThreadSource,
  ThreadStage,
  ThreadStatus,
  ThreadWithMessages,
} from '@funny/shared';
import { parseStoredJson } from '@funny/shared/json-validation';
import { z } from 'zod';

import type { threads } from '../db/schema.js';
import { log } from './logger.js';

type ThreadRow = typeof threads.$inferSelect;

/** List rows also carry the comment count and the last assistant snippet. */
type ListedThreadRow = ThreadRow & { commentCount?: number; lastAssistantMessage?: string };

const templateVariablesSchema = z.record(z.string(), z.string());

function templateVariables(row: ThreadRow): Record<string, string> | undefined {
  if (!row.templateVariables) return undefined;
  const parsed = parseStoredJson(
    templateVariablesSchema,
    row.templateVariables,
    'templateVariables',
  );
  if (parsed.ok) return parsed.value;
  log.warn('Dropping unreadable thread template variables', {
    namespace: 'threads',
    threadId: row.id,
    error: parsed.error,
  });
  return undefined;
}

export function toThread(row: ListedThreadRow): Thread {
  return {
    id: row.id,
    projectId: row.projectId ?? '',
    isScratch: row.isScratch === 1,
    userId: row.userId,
    title: row.title,
    mode: row.mode as ThreadMode,
    status: row.status as ThreadStatus,
    stage: row.stage as ThreadStage,
    provider: row.provider as AgentProvider,
    permissionMode: row.permissionMode as PermissionMode,
    model: row.model as AgentModel,
    branch: row.branch ?? undefined,
    baseBranch: row.baseBranch ?? undefined,
    worktreePath: row.worktreePath ?? undefined,
    sessionId: row.sessionId ?? undefined,
    initialPrompt: row.initialPrompt ?? undefined,
    cost: row.cost,
    archived: row.archived === 1,
    pinned: row.pinned === 1,
    schedulerManaged: row.schedulerManaged === 1,
    source: row.source as ThreadSource,
    externalRequestId: row.externalRequestId ?? undefined,
    parentThreadId: row.parentThreadId ?? undefined,
    designId: row.designId ?? undefined,
    runtime: row.runtime as ThreadRuntime,
    containerUrl: row.containerUrl ?? undefined,
    containerName: row.containerName ?? undefined,
    commentCount: row.commentCount,
    contextRecoveryReason: row.contextRecoveryReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? undefined,
    createdBy: row.createdBy ?? undefined,
    lastAssistantMessage: row.lastAssistantMessage,
    agentTemplateId: row.agentTemplateId ?? undefined,
    agentProfileId: row.agentProfileId,
    agentProfileName: row.agentProfileName,
    agentProfileProvider: row.agentProfileProvider as AgentProvider | null,
    templateVariables: templateVariables(row),
    fileCheckpointingEnabled: row.fileCheckpointingEnabled === 1,
  };
}

/** The message window and wait state `getThreadWithMessages` adds to the row. */
type ThreadDetailRow = ThreadRow &
  Pick<
    ThreadWithMessages,
    | 'messages'
    | 'hasMore'
    | 'hasMoreAfter'
    | 'total'
    | 'windowStart'
    | 'lastUserMessage'
    | 'leadingUserMessage'
    | 'initInfo'
    | 'waitingReason'
    | 'pendingPermission'
  >;

export function toThreadDetail(row: ThreadDetailRow): ThreadWithMessages {
  return {
    ...toThread(row),
    messages: row.messages,
    hasMore: row.hasMore,
    hasMoreAfter: row.hasMoreAfter,
    total: row.total,
    windowStart: row.windowStart,
    lastUserMessage: row.lastUserMessage,
    leadingUserMessage: row.leadingUserMessage,
    initInfo: row.initInfo,
    waitingReason: row.waitingReason,
    pendingPermission: row.pendingPermission,
  };
}
