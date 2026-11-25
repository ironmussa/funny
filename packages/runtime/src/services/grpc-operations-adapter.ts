import type { JsonObject, JsonValue } from '@bufbuild/protobuf';
import { waitFor } from '@funny/shared/async';
import { FailureCode } from '@funny/shared/runner-v2/common';
import { nanoid } from 'nanoid';

import { log } from '../lib/logger.js';
import { isBigInt, isBoolean, isNumber, isObject, isString } from '../lib/value-guards.js';
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
  'data:get_github_app_token',
  'data:get_project_secrets',
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
  'data:activity_start',
  'data:activity_update',
  'data:activity_reconcile',
  'data:factory_list_runs',
  'data:factory_control_run',
  'data:factory_request_approval',
] as const;

export type RunnerOperationEventType = (typeof RUNNER_OPERATION_EVENT_TYPES)[number];

/**
 * What a runner operation resolves with: the JSON form of the server's answer
 * (a field the answer lacks is left `undefined`).
 */
export type RunnerOperationOutcome =
  | JsonValue
  | { readonly [field: string]: RunnerOperationOutcome | undefined };

/** proto3 JSON of `runner.v2.OperationSuccess` (int64 fields are decimal strings). */
export interface OperationSuccessJson {
  acknowledgement?: JsonObject;
  thread?: { value?: JsonObject };
  threadMessages?: {
    messages?: JsonObject[];
    hasMore?: boolean;
    hasMoreAfter?: boolean;
    total?: string;
    windowStart?: string;
    leadingUserMessage?: JsonObject;
  };
  toolCall?: { id?: string; name?: string; input?: string; output?: string };
  insertedRecord?: { id?: string };
  deletedRecords?: { count?: string };
  operationResponse?: JsonObject;
}

type PendingOperation = {
  eventType: RunnerOperationEventType;
  kind: string;
  value: JsonObject;
  resolve(value: RunnerOperationOutcome): void;
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

/**
 * Parses a JS value into protobuf JSON: dates become ISO strings, bigints
 * decimal strings, non-finite numbers `null`, lone surrogates U+FFFD, and
 * `undefined` (or any other non-JSON value) is dropped.
 */
function normalizeProtobufJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || isBoolean(value)) return value;
  if (isString(value)) return normalizeProtobufString(value);
  if (isNumber(value)) return Number.isFinite(value) ? value : null;
  if (isBigInt(value)) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeProtobufJson(item) ?? null);
  if (isObject(value)) return normalizeProtobufObject(value);
  return undefined;
}

function normalizeProtobufObject<Value extends object>(value: Value): JsonObject {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const json = normalizeProtobufJson(item);
      return json === undefined ? [] : [[key, json] as const];
    }),
  );
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isObject(value) && !Array.isArray(value);
}

export function normalizeRunnerOperationValue<Value extends object>(
  kind: string,
  value: Value,
): JsonObject {
  const normalized = normalizeProtobufObject(value);
  switch (kind) {
    case 'insertMessage': {
      const imagesJson = normalized.imagesJson ?? normalized.images;
      return normalizeProtobufObject({
        threadId: normalized.threadId,
        role: normalized.role,
        content: normalized.content,
        imagesJson: imagesJson ?? undefined,
        model: normalized.model ?? undefined,
        permissionMode: normalized.permissionMode ?? undefined,
        effort: normalized.effort ?? undefined,
        author: normalized.author ?? undefined,
        timestamp: normalized.timestamp ?? undefined,
      });
    }
    case 'createPermissionRule':
      return normalizeProtobufObject({
        projectPath: normalized.projectPath,
        toolName: normalized.toolName,
        pattern: normalized.pattern ?? undefined,
        decision: normalized.decision,
      });
    case 'findPermissionRule':
      return normalizeProtobufObject({
        projectPath: normalized.projectPath,
        toolName: normalized.toolName,
        toolInput: normalized.toolInput ?? undefined,
      });
    case 'listPermissionRules':
      return normalizeProtobufObject({
        projectPath: normalized.projectPath ?? undefined,
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
  'activityStart',
  'activityUpdate',
  'activityReconcile',
]);

type OperationValueMapper = (input: JsonObject, payload: JsonObject) => JsonObject;
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
  'data:get_github_app_token': ['getGithubAppToken', inputThreadId],
  'data:get_project_secrets': ['getProjectSecrets', inputThreadId],
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
    (_input, payload) => {
      const value: JsonObject = { watcherId: payload.id, patch: payload.patch };
      if (payload.expectedNextWakeAt !== undefined) {
        value.expectedNextWakeAtMs = String(payload.expectedNextWakeAt);
      }
      return value;
    },
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
  'data:factory_list_runs': ['factoryListRuns', inputThreadId],
  'data:factory_control_run': [
    'factoryControlRun',
    (input) => ({ threadId: input.threadId, runId: input.runId, action: input.action }),
  ],
  'data:factory_request_approval': [
    'factoryRequestApproval',
    (input) => ({ threadId: input.threadId, runId: input.runId }),
  ],
  'data:activity_start': ['activityStart', (_input, payload) => ({ activity: payload })],
  'data:activity_update': [
    'activityUpdate',
    (_input, payload) => ({ activityId: payload.id, patch: payload.patch }),
  ],
  'data:activity_reconcile': [
    'activityReconcile',
    (_input, payload) => ({ liveActivityIds: payload.liveIds ?? [] }),
  ],
};

/** A runner.v2 operation: the `OperationsRequest` field name and its value. */
export interface RunnerOperation {
  kind: string;
  value: JsonObject;
}

export function mapRunnerOperation<Body extends object>(
  eventType: RunnerOperationEventType,
  body: Body,
): RunnerOperation {
  const [kind, toValue] = OPERATION_MAPPINGS[eventType];
  const input = normalizeProtobufObject(body);
  return { kind, value: toValue(input, operationPayload(input)) };
}

/** Most `data:*` bodies carry their fields under `payload`; the rest carry them inline. */
function operationPayload(input: JsonObject): JsonObject {
  const payload = input.payload;
  if (payload === undefined || payload === null) return input;
  return isJsonObject(payload) ? payload : {};
}

export function mapRunnerOperationOutcome(
  kind: string,
  success: OperationSuccessJson,
): RunnerOperationOutcome {
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

function missingOperationResult(kind: string): RunnerOperationOutcome | undefined {
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
  return RUNNER_OPERATION_EVENT_TYPES.some((type) => type === value);
}

/** Anti-corruption layer for application operations over runner.v2 protobuf. */
export class GrpcOperationsAdapter {
  private readonly pending = new Map<string, PendingOperation>();
  private readonly deliveryKeys = new Map<string, string>();
  private shuttingDown = false;

  constructor(
    private readonly sender: GrpcOperationSender,
    private readonly outbox: GrpcOperationOutbox = new GrpcOperationOutbox(),
  ) {}

  request<Body extends object>(eventType: string, input: Body): Promise<any> {
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
    return waitFor((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(correlationId);
        this.deliveryKeys.delete(correlationId);
        clearTimeout(item.timer);
      };
      const item: PendingOperation = {
        eventType,
        kind: operation.kind,
        value: operation.value,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          // The waiting caller owns the outcome: once it is told the write failed,
          // the outbox must not replay it later as a ghost write (#193). Only a
          // shutdown leaves the row, so the next process can finish the write.
          if (idempotencyKey && !this.shuttingDown) this.outbox.discard(idempotencyKey);
          reject(error);
        },
        // This deadline is reset after delivery; unref keeps it from owning process lifetime.
        timer: setTimeout(() => {
          item.reject(
            new Error(`Data request timed out waiting for runner connection (${eventType})`),
          );
        }, CONNECTION_TIMEOUT_MS),
        idempotencyKey,
      };
      item.timer.unref?.();
      this.pending.set(correlationId, item);
      try {
        this.send(correlationId, operation.kind, operation.value, idempotencyKey);
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
      // Also release resources if the Effect wait is interrupted.
      return cleanup;
    });
  }

  activated(): void {
    for (const [correlationId, item] of this.pending) {
      this.send(correlationId, item.kind, item.value, item.idempotencyKey);
    }
    const liveKeys = new Set(
      [...this.pending.values()].flatMap((item) =>
        item.idempotencyKey ? [item.idempotencyKey] : [],
      ),
    );
    const reportDropped = (idempotencyKey: string, reason: string, detail?: string) => {
      log.warn('Dropped gRPC outbox entry instead of replaying it', {
        namespace: 'grpc-outbox',
        idempotencyKey,
        reason,
        detail,
      });
    };
    for (const item of this.outbox.replayable({ onDropped: reportDropped })) {
      if (liveKeys.has(item.idempotencyKey)) continue;
      try {
        // SAFETY: the outbox holds only the operation values `request` enqueued,
        // which `normalizeRunnerOperationValue` returned as JSON objects.
        const payload = item.payload as JsonObject;
        this.send(nanoid(), item.operationKind, payload, item.idempotencyKey);
      } catch (error) {
        // A row that cannot be encoded never will be: drop it and keep replaying.
        this.outbox.discard(item.idempotencyKey);
        reportDropped(
          item.idempotencyKey,
          'unsendable',
          error instanceof Error ? error.message : String(error),
        );
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
      if (message.failure.code === FailureCode.NOT_FOUND) {
        const missing = missingOperationResult(pending.kind);
        if (missing !== undefined) return pending.resolve(missing);
      }
      pending.reject(new Error(String(message.failure.message ?? 'gRPC operation failed')));
      return;
    }
    if (message.success && pending) {
      pending.resolve(mapRunnerOperationOutcome(pending.kind, message.success));
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const item of this.pending.values()) {
      item.reject(new Error('gRPC runner transport shut down'));
    }
    this.pending.clear();
    this.deliveryKeys.clear();
    this.outbox.close();
  }

  private send(
    correlationId: string,
    kind: string,
    value: JsonObject,
    idempotencyKey?: string,
  ): void {
    const sent = this.sender.send('operations', {
      metadata: {
        correlationId,
        deadline: new Date(Date.now() + OPERATION_TIMEOUT_MS).toISOString(),
        ...(idempotencyKey ? { idempotencyKey } : undefined),
      },
      [kind]: normalizeRunnerOperationValue(kind, value),
    });
    if (sent) {
      const pending = this.pending.get(correlationId);
      if (pending) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
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
