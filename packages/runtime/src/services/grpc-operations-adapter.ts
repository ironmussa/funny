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

function normalizeProtobufString(value: string): string {
  let normalized = '';
  let unchangedStart = 0;
  let changed = false;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (codeUnit < 0xdc00 || codeUnit > 0xdfff) {
      continue;
    }

    normalized += `${value.slice(unchangedStart, index)}\uFFFD`;
    unchangedStart = index + 1;
    changed = true;
  }

  return changed ? normalized + value.slice(unchangedStart) : value;
}

function normalizeProtobufJson(value: any): any {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return normalizeProtobufString(value);
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

type OperationValue = Record<string, any>;
type OperationValueMapper = (input: OperationValue, payload: OperationValue) => OperationValue;
type OperationMapping = readonly [kind: string, toValue: OperationValueMapper];

const asInput: OperationValueMapper = (input) => input;
const asPayload: OperationValueMapper = (_input, payload) => payload;
const noValue: OperationValueMapper = () => ({});
const inputThreadId: OperationValueMapper = (input) => ({ threadId: input.threadId });
const inputProjectId: OperationValueMapper = (input) => ({ projectId: input.projectId });
const payloadThreadId: OperationValueMapper = (_input, payload) => ({
  threadId: payload.threadId,
});

const OPERATION_MAPPINGS: Record<RunnerOperationEventType, OperationMapping> = {
  'data:get_thread': ['getThread', inputThreadId],
  'data:get_thread_by_external_request_id': [
    'getThreadByExternalRequestId',
    (input) => ({ externalRequestId: input.externalRequestId }),
  ],
  'data:get_thread_by_session_id': [
    'getThreadByProviderSessionId',
    (input) => ({ providerSessionId: input.sessionId }),
  ],
  'data:get_thread_with_messages': ['getThreadWithMessages', asInput],
  'data:get_thread_messages': [
    'getThreadMessages',
    (input) => ({ ...input, direction: input.direction === 'after' ? 2 : 1 }),
  ],
  'data:get_tool_call': ['getToolCall', (input) => ({ toolCallId: input.toolCallId })],
  'data:find_tool_call': ['findToolCall', asPayload],
  'data:insert_message': ['insertMessage', asPayload],
  'data:insert_tool_call': ['insertToolCall', asPayload],
  'data:update_thread': [
    'updateThread',
    (_input, payload) => ({ threadId: payload.threadId, updates: payload.updates }),
  ],
  'data:update_message': ['updateMessage', asPayload],
  'data:update_tool_call_output': ['updateToolCallOutput', asPayload],
  'data:save_thread_event': ['saveThreadEvent', asPayload],
  'data:create_pending_permission_request': [
    'createPendingPermission',
    (_input, payload) => ({ permission: payload }),
  ],
  'data:resolve_pending_permission_request': [
    'resolvePendingPermission',
    (_input, payload) => ({ permissionRequestId: payload.requestId, decision: payload.decision }),
  ],
  'data:expire_pending_permission_request': [
    'expirePendingPermission',
    (_input, payload) => ({ permissionRequestId: payload.requestId }),
  ],
  'data:insert_comment': ['insertComment', asPayload],
  'data:delete_messages_after': ['deleteMessagesAfter', asPayload],
  'data:search_threads': ['searchThreads', asInput],
  'data:find_last_unanswered_interactive_tool_call': [
    'findLastUnansweredInteractiveToolCall',
    inputThreadId,
  ],
  'data:get_project': ['getProject', inputProjectId],
  'data:get_startup_command': [
    'getStartupCommand',
    (input) => ({ commandId: input.cmdId, projectId: input.projectId }),
  ],
  'data:get_agent_template': ['getAgentTemplate', (input) => ({ templateId: input.templateId })],
  'data:list_projects': ['listProjects', noValue],
  'data:list_project_threads': ['listProjectThreads', inputProjectId],
  'data:resolve_project_path': ['resolveProjectPath', inputProjectId],
  'data:create_project': [
    'createProject',
    (input) => ({ name: input.name, path: input.path, organizationId: input.orgId }),
  ],
  'data:create_thread': ['createThread', (_input, payload) => ({ thread: payload })],
  'data:delete_thread': ['deleteThread', inputThreadId],
  'data:enqueue_message': [
    'enqueueMessage',
    (input, payload) => ({ threadId: input.threadId, message: payload }),
  ],
  'data:dequeue_message': ['dequeueMessage', inputThreadId],
  'data:peek_message': ['peekMessage', inputThreadId],
  'data:queue_count': ['queueCount', inputThreadId],
  'data:list_queue': ['listQueue', inputThreadId],
  'data:cancel_queued_message': [
    'cancelQueuedMessage',
    (input) => ({ messageId: input.messageId }),
  ],
  'data:update_queued_message': [
    'updateQueuedMessage',
    (input) => ({ messageId: input.messageId, content: input.content }),
  ],
  'data:get_profile': ['getProfile', noValue],
  'data:get_provider_key': ['getProviderKey', (input) => ({ provider: input.provider })],
  'data:get_github_token': ['getGithubToken', (input) => ({ projectId: input.projectId ?? '' })],
  'data:get_minimax_api_key': ['getMinimaxApiKey', noValue],
  'data:update_profile': ['updateProfile', (_input, payload) => ({ updates: payload })],
  'data:resolve_agent_execution_profile': ['resolveAgentExecutionProfile', inputProjectId],
  'data:get_builtin_providers': ['getBuiltinProviders', noValue],
  'data:set_builtin_providers': ['setBuiltinProviders', (input) => ({ active: input.active })],
  'data:mark_and_list_stale_threads': ['markAndListStaleThreads', noValue],
  'data:watcher_insert': [
    'watcherInsert',
    (_input, payload) => ({ threadId: payload.threadId, watcher: payload.row }),
  ],
  'data:watcher_get': ['watcherGet', (_input, payload) => ({ watcherId: payload.id })],
  'data:watcher_get_live_by_thread_key': ['watcherGetLiveByThreadKey', asPayload],
  'data:watcher_list_pending': ['watcherListPending', noValue],
  'data:watcher_list_due': [
    'watcherListDue',
    (_input, payload) => ({ nowMs: String(payload.now) }),
  ],
  'data:watcher_list_by_user': ['watcherListByUser', noValue],
  'data:watcher_update': [
    'watcherUpdate',
    (_input, payload) => ({ watcherId: payload.id, patch: payload.patch }),
  ],
  'data:watcher_delete_by_thread': ['watcherDeleteByThread', payloadThreadId],
  'data:job_insert': [
    'jobInsert',
    (_input, payload) => ({ threadId: payload.threadId, job: payload.row }),
  ],
  'data:job_get': ['jobGet', (_input, payload) => ({ jobId: payload.id })],
  'data:job_list_running': ['jobListRunning', noValue],
  'data:job_list_by_user': ['jobListByUser', noValue],
  'data:job_update': [
    'jobUpdate',
    (_input, payload) => ({ jobId: payload.id, patch: payload.patch }),
  ],
  'data:job_delete_by_thread': ['jobDeleteByThread', payloadThreadId],
  'data:create_permission_rule': ['createPermissionRule', asPayload],
  'data:find_permission_rule': ['findPermissionRule', asPayload],
  'data:list_permission_rules': ['listPermissionRules', asPayload],
};

export function mapRunnerOperation(
  eventType: RunnerOperationEventType,
  input: Record<string, any>,
): { kind: string; value: Record<string, any> } {
  const [kind, toValue] = OPERATION_MAPPINGS[eventType];
  return { kind, value: toValue(input, input.payload ?? input) };
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
