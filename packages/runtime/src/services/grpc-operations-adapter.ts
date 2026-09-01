import { FailureCode } from '@funny/shared/runner-v2/common';
import { nanoid } from 'nanoid';

import { GrpcOperationOutbox } from './grpc-operation-outbox.js';
import type { RunnerGrpcWireMessage } from './grpc-runner-client.js';

const OPERATION_TIMEOUT_MS = 15_000;
const CONNECTION_TIMEOUT_MS = 30_000;

export const RUNNER_OPERATION_EVENT_TYPES = [
  'data:get_thread',
  'data:get_thread_by_external_request_id',
  'data:get_thread_by_session_id',
  'data:get_thread_with_messages',
  'data:get_thread_messages',
  'data:get_tool_call',
  'data:find_tool_call',
  'data:insert_message',
  'data:insert_tool_call',
  'data:update_thread',
  'data:update_message',
  'data:update_tool_call_output',
  'data:save_thread_event',
  'data:create_pending_permission_request',
  'data:resolve_pending_permission_request',
  'data:expire_pending_permission_request',
  'data:insert_comment',
  'data:delete_messages_after',
  'data:search_threads',
  'data:find_last_unanswered_interactive_tool_call',
  'data:get_project',
  'data:get_startup_command',
  'data:get_agent_template',
  'data:list_projects',
  'data:list_project_threads',
  'data:resolve_project_path',
  'data:create_project',
  'data:create_thread',
  'data:delete_thread',
  'data:enqueue_message',
  'data:dequeue_message',
  'data:peek_message',
  'data:queue_count',
  'data:list_queue',
  'data:cancel_queued_message',
  'data:update_queued_message',
  'data:get_profile',
  'data:get_provider_key',
  'data:get_github_token',
  'data:get_minimax_api_key',
  'data:update_profile',
  'data:resolve_agent_execution_profile',
  'data:get_builtin_providers',
  'data:set_builtin_providers',
  'data:mark_and_list_stale_threads',
  'data:watcher_insert',
  'data:watcher_get',
  'data:watcher_get_live_by_thread_key',
  'data:watcher_list_pending',
  'data:watcher_list_due',
  'data:watcher_list_by_user',
  'data:watcher_update',
  'data:watcher_delete_by_thread',
  'data:job_insert',
  'data:job_get',
  'data:job_list_running',
  'data:job_list_by_user',
  'data:job_update',
  'data:job_delete_by_thread',
  'data:create_permission_rule',
  'data:find_permission_rule',
  'data:list_permission_rules',
] as const;

export type RunnerOperationEventType = (typeof RUNNER_OPERATION_EVENT_TYPES)[number];

type PendingOperation = {
  eventType: RunnerOperationEventType;
  kind: string;
  value: Record<string, any>;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  idempotencyKey?: string;
};

export interface GrpcOperationSender {
  send(name: 'operations', message: RunnerGrpcWireMessage): boolean;
}

function normalizeProtobufJson(value: any): any {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeProtobufJson(item) ?? null);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, normalizeProtobufJson(item)] as const)
        .filter((entry) => entry[1] !== undefined),
    );
  }
  return undefined;
}

export function normalizeRunnerOperationValue(
  kind: string,
  value: Record<string, any>,
): Record<string, any> {
  const normalized = normalizeProtobufJson(value) as Record<string, any>;
  switch (kind) {
    case 'insertMessage': {
      const imagesJson = normalized.imagesJson ?? normalized.images;
      return normalizeProtobufJson({
        threadId: normalized.threadId,
        role: normalized.role,
        content: normalized.content,
        ...(imagesJson == null ? {} : { imagesJson }),
        ...(normalized.model == null ? {} : { model: normalized.model }),
        ...(normalized.permissionMode == null ? {} : { permissionMode: normalized.permissionMode }),
        ...(normalized.effort == null ? {} : { effort: normalized.effort }),
        ...(normalized.author == null ? {} : { author: normalized.author }),
        ...(normalized.timestamp == null ? {} : { timestamp: normalized.timestamp }),
      });
    }
    case 'createPermissionRule':
      return normalizeProtobufJson({
        projectPath: normalized.projectPath,
        toolName: normalized.toolName,
        ...(normalized.pattern == null ? {} : { pattern: normalized.pattern }),
        decision: normalized.decision,
      });
    case 'findPermissionRule':
      return normalizeProtobufJson({
        projectPath: normalized.projectPath,
        toolName: normalized.toolName,
        ...(normalized.toolInput == null ? {} : { toolInput: normalized.toolInput }),
      });
    case 'listPermissionRules':
      return normalizeProtobufJson({
        ...(normalized.projectPath == null ? {} : { projectPath: normalized.projectPath }),
      });
    default:
      return normalized;
  }
}

const persistentMutations = new Set([
  'insertMessage',
  'insertToolCall',
  'updateThread',
  'updateMessage',
  'updateToolCallOutput',
  'saveThreadEvent',
  'createPendingPermission',
  'resolvePendingPermission',
  'expirePendingPermission',
  'insertComment',
  'deleteMessagesAfter',
  'createProject',
  'createThread',
  'deleteThread',
  'enqueueMessage',
  'dequeueMessage',
  'cancelQueuedMessage',
  'updateQueuedMessage',
  'updateProfile',
  'setBuiltinProviders',
  'watcherInsert',
  'watcherUpdate',
  'watcherDeleteByThread',
  'jobInsert',
  'jobUpdate',
  'jobDeleteByThread',
  'createPermissionRule',
]);

export function mapRunnerOperation(
  eventType: RunnerOperationEventType,
  input: Record<string, any>,
): { kind: string; value: Record<string, any> } {
  const payload = input.payload ?? input;
  switch (eventType) {
    case 'data:get_thread':
      return { kind: 'getThread', value: { threadId: input.threadId } };
    case 'data:get_thread_by_external_request_id':
      return {
        kind: 'getThreadByExternalRequestId',
        value: { externalRequestId: input.externalRequestId },
      };
    case 'data:get_thread_by_session_id':
      return {
        kind: 'getThreadByProviderSessionId',
        value: { providerSessionId: input.sessionId },
      };
    case 'data:get_thread_with_messages':
      return { kind: 'getThreadWithMessages', value: input };
    case 'data:get_thread_messages':
      return {
        kind: 'getThreadMessages',
        value: { ...input, direction: input.direction === 'after' ? 2 : 1 },
      };
    case 'data:get_tool_call':
      return { kind: 'getToolCall', value: { toolCallId: input.toolCallId } };
    case 'data:find_tool_call':
      return { kind: 'findToolCall', value: payload };
    case 'data:insert_message':
      return { kind: 'insertMessage', value: payload };
    case 'data:insert_tool_call':
      return { kind: 'insertToolCall', value: payload };
    case 'data:update_thread':
      return {
        kind: 'updateThread',
        value: { threadId: payload.threadId, updates: payload.updates },
      };
    case 'data:update_message':
      return { kind: 'updateMessage', value: payload };
    case 'data:update_tool_call_output':
      return { kind: 'updateToolCallOutput', value: payload };
    case 'data:save_thread_event':
      return { kind: 'saveThreadEvent', value: payload };
    case 'data:create_pending_permission_request':
      return { kind: 'createPendingPermission', value: { permission: payload } };
    case 'data:resolve_pending_permission_request':
      return {
        kind: 'resolvePendingPermission',
        value: { permissionRequestId: payload.requestId, decision: payload.decision },
      };
    case 'data:expire_pending_permission_request':
      return { kind: 'expirePendingPermission', value: { permissionRequestId: payload.requestId } };
    case 'data:insert_comment':
      return { kind: 'insertComment', value: payload };
    case 'data:delete_messages_after':
      return { kind: 'deleteMessagesAfter', value: payload };
    case 'data:search_threads':
      return { kind: 'searchThreads', value: input };
    case 'data:find_last_unanswered_interactive_tool_call':
      return { kind: 'findLastUnansweredInteractiveToolCall', value: { threadId: input.threadId } };
    case 'data:get_project':
      return { kind: 'getProject', value: { projectId: input.projectId } };
    case 'data:get_startup_command':
      return {
        kind: 'getStartupCommand',
        value: { commandId: input.cmdId, projectId: input.projectId },
      };
    case 'data:get_agent_template':
      return { kind: 'getAgentTemplate', value: { templateId: input.templateId } };
    case 'data:list_projects':
      return { kind: 'listProjects', value: {} };
    case 'data:list_project_threads':
      return { kind: 'listProjectThreads', value: { projectId: input.projectId } };
    case 'data:resolve_project_path':
      return { kind: 'resolveProjectPath', value: { projectId: input.projectId } };
    case 'data:create_project':
      return {
        kind: 'createProject',
        value: { name: input.name, path: input.path, organizationId: input.orgId },
      };
    case 'data:create_thread':
      return { kind: 'createThread', value: { thread: payload } };
    case 'data:delete_thread':
      return { kind: 'deleteThread', value: { threadId: input.threadId } };
    case 'data:enqueue_message':
      return { kind: 'enqueueMessage', value: { threadId: input.threadId, message: payload } };
    case 'data:dequeue_message':
      return { kind: 'dequeueMessage', value: { threadId: input.threadId } };
    case 'data:peek_message':
      return { kind: 'peekMessage', value: { threadId: input.threadId } };
    case 'data:queue_count':
      return { kind: 'queueCount', value: { threadId: input.threadId } };
    case 'data:list_queue':
      return { kind: 'listQueue', value: { threadId: input.threadId } };
    case 'data:cancel_queued_message':
      return { kind: 'cancelQueuedMessage', value: { messageId: input.messageId } };
    case 'data:update_queued_message':
      return {
        kind: 'updateQueuedMessage',
        value: { messageId: input.messageId, content: input.content },
      };
    case 'data:get_profile':
      return { kind: 'getProfile', value: {} };
    case 'data:get_provider_key':
      return { kind: 'getProviderKey', value: { provider: input.provider } };
    case 'data:get_github_token':
      return { kind: 'getGithubToken', value: {} };
    case 'data:get_minimax_api_key':
      return { kind: 'getMinimaxApiKey', value: {} };
    case 'data:update_profile':
      return { kind: 'updateProfile', value: { updates: payload } };
    case 'data:resolve_agent_execution_profile':
      return { kind: 'resolveAgentExecutionProfile', value: { projectId: input.projectId } };
    case 'data:get_builtin_providers':
      return { kind: 'getBuiltinProviders', value: {} };
    case 'data:set_builtin_providers':
      return { kind: 'setBuiltinProviders', value: { active: input.active } };
    case 'data:mark_and_list_stale_threads':
      return { kind: 'markAndListStaleThreads', value: {} };
    case 'data:watcher_insert':
      return { kind: 'watcherInsert', value: { threadId: payload.threadId, watcher: payload.row } };
    case 'data:watcher_get':
      return { kind: 'watcherGet', value: { watcherId: payload.id } };
    case 'data:watcher_get_live_by_thread_key':
      return { kind: 'watcherGetLiveByThreadKey', value: payload };
    case 'data:watcher_list_pending':
      return { kind: 'watcherListPending', value: {} };
    case 'data:watcher_list_due':
      return { kind: 'watcherListDue', value: { nowMs: String(payload.now) } };
    case 'data:watcher_list_by_user':
      return { kind: 'watcherListByUser', value: {} };
    case 'data:watcher_update':
      return { kind: 'watcherUpdate', value: { watcherId: payload.id, patch: payload.patch } };
    case 'data:watcher_delete_by_thread':
      return { kind: 'watcherDeleteByThread', value: { threadId: payload.threadId } };
    case 'data:job_insert':
      return { kind: 'jobInsert', value: { threadId: payload.threadId, job: payload.row } };
    case 'data:job_get':
      return { kind: 'jobGet', value: { jobId: payload.id } };
    case 'data:job_list_running':
      return { kind: 'jobListRunning', value: {} };
    case 'data:job_list_by_user':
      return { kind: 'jobListByUser', value: {} };
    case 'data:job_update':
      return { kind: 'jobUpdate', value: { jobId: payload.id, patch: payload.patch } };
    case 'data:job_delete_by_thread':
      return { kind: 'jobDeleteByThread', value: { threadId: payload.threadId } };
    case 'data:create_permission_rule':
      return { kind: 'createPermissionRule', value: payload };
    case 'data:find_permission_rule':
      return { kind: 'findPermissionRule', value: payload };
    case 'data:list_permission_rules':
      return { kind: 'listPermissionRules', value: payload };
  }
}

export function mapRunnerOperationOutcome(kind: string, success: Record<string, any>): unknown {
  if (success.operationResponse !== undefined) return success.operationResponse;
  if (success.threadMessages)
    return { type: 'data:get_thread_messages_response', ...success.threadMessages };
  if (success.thread) return { type: 'data:get_thread_response', thread: success.thread.value };
  if (success.toolCall) return { type: 'data:get_tool_call_response', toolCall: success.toolCall };
  if (success.insertedRecord) {
    if (kind === 'insertMessage') return { messageId: success.insertedRecord.id };
    if (kind === 'insertToolCall') return { toolCallId: success.insertedRecord.id };
    return { commentId: success.insertedRecord.id };
  }
  if (success.deletedRecords) return { deletedCount: Number(success.deletedRecords.count) };
  return { success: true };
}

function missingOperationResult(kind: string): unknown | undefined {
  if (
    kind === 'getThread' ||
    kind === 'getThreadByExternalRequestId' ||
    kind === 'getThreadByProviderSessionId' ||
    kind === 'getThreadWithMessages'
  ) {
    return { type: 'data:get_thread_response', thread: null };
  }
  if (kind === 'getToolCall' || kind === 'findToolCall') {
    return { type: 'data:get_tool_call_response', toolCall: null };
  }
  return undefined;
}

function isRunnerOperationEventType(value: string): value is RunnerOperationEventType {
  return (RUNNER_OPERATION_EVENT_TYPES as readonly string[]).includes(value);
}

/** Anti-corruption layer for application operations over runner.v2 protobuf. */
export class GrpcOperationsAdapter {
  private readonly pending = new Map<string, PendingOperation>();
  private readonly deliveryKeys = new Map<string, string>();

  constructor(
    private readonly sender: GrpcOperationSender,
    private readonly outbox: GrpcOperationOutbox = new GrpcOperationOutbox(),
  ) {}

  request(eventType: string, input: Record<string, any>): Promise<any> {
    if (!isRunnerOperationEventType(eventType)) {
      throw new Error(`Unsupported gRPC runner operation: ${eventType}`);
    }
    const mapped = mapRunnerOperation(eventType, input);
    const operation = {
      ...mapped,
      value: normalizeRunnerOperationValue(mapped.kind, mapped.value),
    };
    const correlationId = nanoid();
    const idempotencyKey = persistentMutations.has(operation.kind) ? nanoid() : undefined;
    if (idempotencyKey) {
      this.outbox.enqueue({
        idempotencyKey,
        operationKind: operation.kind,
        payload: operation.value,
      });
    }
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error(`Data request timed out waiting for runner connection (${eventType})`));
      }, CONNECTION_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(correlationId, {
        eventType,
        kind: operation.kind,
        value: operation.value,
        resolve,
        reject,
        timer,
        idempotencyKey,
      });
    });
    this.send(correlationId, operation.kind, operation.value, idempotencyKey);
    return promise;
  }

  activated(): void {
    for (const [correlationId, item] of this.pending) {
      this.send(correlationId, item.kind, item.value, item.idempotencyKey);
    }
    const liveKeys = new Set(
      [...this.pending.values()]
        .map((item) => item.idempotencyKey)
        .filter((key): key is string => Boolean(key)),
    );
    for (const item of this.outbox.pending()) {
      if (!liveKeys.has(item.idempotencyKey)) {
        this.send(nanoid(), item.operationKind, item.payload, item.idempotencyKey);
      }
    }
  }

  receive(message: RunnerGrpcWireMessage): void {
    const correlationId = String(message.correlationId ?? '');
    const pending = this.pending.get(correlationId);
    const deliveryKey = this.deliveryKeys.get(correlationId);
    this.deliveryKeys.delete(correlationId);
    if (deliveryKey && (message.success || message.failure)) this.outbox.confirm(deliveryKey);
    if (message.failure) {
      if (!pending) return;
      this.pending.delete(correlationId);
      clearTimeout(pending.timer);
      if (message.failure.code === FailureCode.NOT_FOUND) {
        const missing = missingOperationResult(pending.kind);
        if (missing !== undefined) return pending.resolve(missing);
      }
      pending.reject(new Error(String(message.failure.message ?? 'gRPC operation failed')));
      return;
    }
    if (message.success && pending) {
      this.pending.delete(correlationId);
      clearTimeout(pending.timer);
      pending.resolve(mapRunnerOperationOutcome(pending.kind, message.success));
    }
  }

  shutdown(): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('gRPC runner transport shut down'));
    }
    this.pending.clear();
    this.deliveryKeys.clear();
    this.outbox.close();
  }

  private send(correlationId: string, kind: string, value: unknown, idempotencyKey?: string): void {
    const sent = this.sender.send('operations', {
      metadata: {
        correlationId,
        deadline: new Date(Date.now() + OPERATION_TIMEOUT_MS).toISOString(),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
      [kind]: normalizeRunnerOperationValue(kind, value as Record<string, any>),
    });
    if (sent) {
      const pending = this.pending.get(correlationId);
      if (pending) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          this.pending.delete(correlationId);
          pending.reject(new Error(`Data request timed out (${pending.eventType})`));
        }, OPERATION_TIMEOUT_MS);
        pending.timer.unref?.();
      }
    }
    if (sent && idempotencyKey) {
      this.deliveryKeys.set(correlationId, idempotencyKey);
      this.outbox.markAttempt(idempotencyKey);
    }
  }
}
