import { FailureCode } from '@funny/shared/runner-v2/common';

import { log } from '../../lib/logger.js';
import { handleDataMessageWithAck } from '../data-handler.js';
import type { RunnerGrpcConfig } from './config.js';
import {
  SqlOperationIdempotencyStore,
  type OperationIdempotencyStore,
} from './operation-idempotency.js';
import type {
  RunnerGrpcCall,
  RunnerGrpcCallContext,
  RunnerGrpcHandler,
} from './runner-grpc-server.js';
import type { RunnerGrpcSessionRegistry } from './session-registry.js';
import { observeRunnerGrpc } from './transport-observability.js';

type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue };
type WireRequest = Record<string, any> & {
  operation?: string;
  session?: { sessionEpoch?: string | number | bigint };
  metadata?: {
    correlationId?: string;
    deadline?: { seconds?: string | number | bigint; nanos?: number };
    idempotencyKey?: string;
  };
};

export interface OperationExecution {
  request: Record<string, unknown>;
  signal: AbortSignal;
}

export interface OperationsHandlerOptions {
  execute?: (context: RunnerGrpcCallContext, operation: OperationExecution) => Promise<unknown>;
  idempotency?: OperationIdempotencyStore;
  now?: () => number;
}

// Runtime correlation IDs come from nanoid, whose URL-safe alphabet may put
// '-' or '_' in the first position.
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/;
const PERSISTENT_MUTATIONS = new Set([
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

const OPERATION_KINDS = [
  'getThread',
  'getThreadByExternalRequestId',
  'getThreadByProviderSessionId',
  'getThreadWithMessages',
  'getThreadMessages',
  'getToolCall',
  'findToolCall',
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
  'searchThreads',
  'findLastUnansweredInteractiveToolCall',
  'getProject',
  'getStartupCommand',
  'getAgentTemplate',
  'listProjects',
  'listProjectThreads',
  'resolveProjectPath',
  'createProject',
  'createThread',
  'deleteThread',
  'enqueueMessage',
  'dequeueMessage',
  'peekMessage',
  'queueCount',
  'listQueue',
  'cancelQueuedMessage',
  'updateQueuedMessage',
  'getProfile',
  'getProviderKey',
  'getGithubToken',
  'getMinimaxApiKey',
  'updateProfile',
  'resolveAgentExecutionProfile',
  'getBuiltinProviders',
  'setBuiltinProviders',
  'markAndListStaleThreads',
  'watcherInsert',
  'watcherGet',
  'watcherGetLiveByThreadKey',
  'watcherListPending',
  'watcherListDue',
  'watcherListByUser',
  'watcherUpdate',
  'watcherDeleteByThread',
  'jobInsert',
  'jobGet',
  'jobListRunning',
  'jobListByUser',
  'jobUpdate',
  'jobDeleteByThread',
  'createPermissionRule',
  'findPermissionRule',
  'listPermissionRules',
] as const;

function requestKind(request: WireRequest): string | undefined {
  if (typeof request.operation === 'string') return request.operation;
  return OPERATION_KINDS.find((key) => request[key] !== undefined);
}

function decodeValue(value: any): WireValue {
  if (!value || typeof value !== 'object' || typeof value.kind !== 'string') return value;
  switch (value.kind) {
    case 'nullValue':
      return null;
    case 'numberValue':
      return value.numberValue;
    case 'stringValue':
      return value.stringValue;
    case 'boolValue':
      return value.boolValue;
    case 'structValue':
      return decodeStruct(value.structValue);
    case 'listValue':
      return (value.listValue?.values ?? []).map(decodeValue);
    default:
      return null;
  }
}

function decodeStruct(value: any): Record<string, WireValue> {
  if (!value || typeof value !== 'object') return {};
  if (!value.fields || typeof value.fields !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value.fields).map(([key, field]) => [key, decodeValue(field)]),
  );
}

function encodeValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { nullValue: 0 };
  if (typeof value === 'number') return { numberValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map(encodeValue) } };
  return { structValue: encodeStruct(value) };
}

function encodeStruct(value: unknown): Record<string, unknown> {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    fields: Object.fromEntries(
      Object.entries(record).map(([key, field]) => [key, encodeValue(field)]),
    ),
  };
}

function toLegacyRequest(
  kind: string,
  request: WireRequest,
  principalUserId: string | null,
): Record<string, unknown> | null {
  const value = request[kind] ?? {};
  switch (kind) {
    case 'getThread':
      return { type: 'data:get_thread', threadId: value.threadId };
    case 'getThreadByExternalRequestId':
      return {
        type: 'data:get_thread_by_external_request_id',
        externalRequestId: value.externalRequestId,
      };
    case 'getThreadByProviderSessionId':
      return { type: 'data:get_thread_by_session_id', sessionId: value.providerSessionId };
    case 'getThreadWithMessages':
      return { type: 'data:get_thread_with_messages', ...value };
    case 'getThreadMessages':
      return {
        type: 'data:get_thread_messages',
        ...value,
        direction:
          value.direction === 2 || value.direction === 'MESSAGE_PAGE_DIRECTION_AFTER'
            ? 'after'
            : 'before',
      };
    case 'getToolCall':
      return { type: 'data:get_tool_call', toolCallId: value.toolCallId };
    case 'findToolCall':
      return { type: 'data:find_tool_call', payload: value };
    case 'insertMessage':
      return {
        type: 'data:insert_message',
        threadId: value.threadId,
        payload: {
          threadId: value.threadId,
          role: value.role,
          content: value.content,
          images: value.imagesJson ?? null,
          model: value.model ?? null,
          permissionMode: value.permissionMode ?? null,
          effort: value.effort ?? null,
          author: value.author ?? null,
          timestamp: value.timestamp ?? null,
        },
      };
    case 'insertToolCall':
      return { type: 'data:insert_tool_call', payload: value };
    case 'updateThread':
      return {
        type: 'data:update_thread',
        threadId: value.threadId,
        payload: { threadId: value.threadId, updates: decodeStruct(value.updates) },
      };
    case 'updateMessage':
      return { type: 'data:update_message', payload: value };
    case 'updateToolCallOutput':
      return { type: 'data:update_tool_call_output', payload: value };
    case 'saveThreadEvent':
      return {
        type: 'data:save_thread_event',
        threadId: value.threadId,
        payload: { ...value, data: decodeStruct(value.data) },
      };
    case 'createPendingPermission':
      return {
        type: 'data:create_pending_permission_request',
        payload: decodeStruct(value.permission),
      };
    case 'resolvePendingPermission':
      return {
        type: 'data:resolve_pending_permission_request',
        payload: { requestId: value.permissionRequestId, decision: value.decision },
      };
    case 'expirePendingPermission':
      return {
        type: 'data:expire_pending_permission_request',
        payload: { requestId: value.permissionRequestId },
      };
    case 'insertComment':
      return { type: 'data:insert_comment', threadId: value.threadId, payload: value };
    case 'deleteMessagesAfter':
      return { type: 'data:delete_messages_after', threadId: value.threadId, payload: value };
    case 'searchThreads':
      return { type: 'data:search_threads', ...value };
    case 'findLastUnansweredInteractiveToolCall':
      return { type: 'data:find_last_unanswered_interactive_tool_call', threadId: value.threadId };
    case 'getProject':
      return { type: 'data:get_project', projectId: value.projectId };
    case 'getStartupCommand':
      return {
        type: 'data:get_startup_command',
        cmdId: value.commandId,
        projectId: value.projectId,
      };
    case 'getAgentTemplate':
      return { type: 'data:get_agent_template', templateId: value.templateId };
    case 'listProjects':
      return { type: 'data:list_projects', userId: principalUserId };
    case 'listProjectThreads':
      return { type: 'data:list_project_threads', projectId: value.projectId };
    case 'resolveProjectPath':
      return {
        type: 'data:resolve_project_path',
        projectId: value.projectId,
        userId: principalUserId,
      };
    case 'createProject':
      return {
        type: 'data:create_project',
        name: value.name,
        path: value.path,
        userId: principalUserId,
        orgId: value.organizationId ?? null,
      };
    case 'createThread':
      return {
        type: 'data:create_thread',
        payload: { ...decodeStruct(value.thread), userId: principalUserId },
      };
    case 'deleteThread':
      return { type: 'data:delete_thread', threadId: value.threadId };
    case 'enqueueMessage':
      return {
        type: 'data:enqueue_message',
        threadId: value.threadId,
        payload: decodeStruct(value.message),
      };
    case 'dequeueMessage':
      return { type: 'data:dequeue_message', threadId: value.threadId };
    case 'peekMessage':
      return { type: 'data:peek_message', threadId: value.threadId };
    case 'queueCount':
      return { type: 'data:queue_count', threadId: value.threadId };
    case 'listQueue':
      return { type: 'data:list_queue', threadId: value.threadId };
    case 'cancelQueuedMessage':
      return { type: 'data:cancel_queued_message', messageId: value.messageId };
    case 'updateQueuedMessage':
      return {
        type: 'data:update_queued_message',
        messageId: value.messageId,
        content: value.content,
      };
    case 'getProfile':
      return { type: 'data:get_profile', userId: principalUserId };
    case 'getProviderKey':
      return { type: 'data:get_provider_key', userId: principalUserId, provider: value.provider };
    case 'getGithubToken':
      return { type: 'data:get_github_token', userId: principalUserId };
    case 'getMinimaxApiKey':
      return { type: 'data:get_minimax_api_key', userId: principalUserId };
    case 'updateProfile':
      return {
        type: 'data:update_profile',
        userId: principalUserId,
        payload: decodeStruct(value.updates),
      };
    case 'resolveAgentExecutionProfile':
      return {
        type: 'data:resolve_agent_execution_profile',
        projectId: value.projectId,
        userId: principalUserId,
      };
    case 'getBuiltinProviders':
      return { type: 'data:get_builtin_providers' };
    case 'setBuiltinProviders':
      return { type: 'data:set_builtin_providers', active: value.active ?? [] };
    case 'markAndListStaleThreads':
      return { type: 'data:mark_and_list_stale_threads' };
    case 'watcherInsert':
      return {
        type: 'data:watcher_insert',
        payload: { threadId: value.threadId, row: decodeStruct(value.watcher) },
      };
    case 'watcherGet':
      return { type: 'data:watcher_get', payload: { id: value.watcherId } };
    case 'watcherGetLiveByThreadKey':
      return {
        type: 'data:watcher_get_live_by_thread_key',
        payload: { threadId: value.threadId, key: value.key },
      };
    case 'watcherListPending':
      return { type: 'data:watcher_list_pending', payload: {} };
    case 'watcherListDue':
      return { type: 'data:watcher_list_due', payload: { now: Number(value.nowMs) } };
    case 'watcherListByUser':
      return { type: 'data:watcher_list_by_user', payload: { userId: principalUserId } };
    case 'watcherUpdate':
      return {
        type: 'data:watcher_update',
        payload: { id: value.watcherId, patch: decodeStruct(value.patch) },
      };
    case 'watcherDeleteByThread':
      return { type: 'data:watcher_delete_by_thread', payload: { threadId: value.threadId } };
    case 'jobInsert':
      return {
        type: 'data:job_insert',
        payload: { threadId: value.threadId, row: decodeStruct(value.job) },
      };
    case 'jobGet':
      return { type: 'data:job_get', payload: { id: value.jobId } };
    case 'jobListRunning':
      return { type: 'data:job_list_running', payload: {} };
    case 'jobListByUser':
      return { type: 'data:job_list_by_user', payload: { userId: principalUserId } };
    case 'jobUpdate':
      return {
        type: 'data:job_update',
        payload: { id: value.jobId, patch: decodeStruct(value.patch) },
      };
    case 'jobDeleteByThread':
      return { type: 'data:job_delete_by_thread', payload: { threadId: value.threadId } };
    case 'createPermissionRule':
      return {
        type: 'data:create_permission_rule',
        payload: { ...value, userId: principalUserId },
      };
    case 'findPermissionRule':
      return { type: 'data:find_permission_rule', payload: { ...value, userId: principalUserId } };
    case 'listPermissionRules':
      return { type: 'data:list_permission_rules', payload: { ...value, userId: principalUserId } };
    default:
      return null;
  }
}

function failure(
  epoch: bigint,
  correlationId: string,
  code: FailureCode,
  message: string,
  retryable = false,
): Record<string, unknown> {
  return {
    session: { sessionEpoch: epoch.toString() },
    correlationId,
    failure: { code, message, retryable },
  };
}

function success(epoch: bigint, correlationId: string, result: any): Record<string, unknown> {
  let payload: Record<string, unknown>;
  if (result?.type === 'data:get_thread_messages_response') {
    payload = {
      threadMessages: {
        messages: (result.messages ?? []).map(encodeStruct),
        hasMore: !!result.hasMore,
        hasMoreAfter: !!result.hasMoreAfter,
        ...(result.total === undefined ? {} : { total: String(result.total) }),
        ...(result.windowStart === undefined ? {} : { windowStart: String(result.windowStart) }),
        ...(result.leadingUserMessage
          ? { leadingUserMessage: encodeStruct(result.leadingUserMessage) }
          : {}),
      },
    };
  } else if (
    result?.type === 'data:get_tool_call_response' ||
    result?.type === 'data:find_tool_call_response'
  ) {
    payload = { toolCall: result.toolCall ?? {} };
  } else if (result?.type?.startsWith('data:get_thread')) {
    payload = { thread: { ...(result.thread ? { value: encodeStruct(result.thread) } : {}) } };
  } else if (typeof result?.messageId === 'string') {
    payload = { insertedRecord: { id: result.messageId } };
  } else if (typeof result?.toolCallId === 'string') {
    payload = { insertedRecord: { id: result.toolCallId } };
  } else if (typeof result?.commentId === 'string') {
    payload = { insertedRecord: { id: result.commentId } };
  } else if (typeof result?.deletedCount === 'number') {
    payload = { deletedRecords: { count: String(result.deletedCount) } };
  } else {
    payload = { operationResponse: encodeStruct(result ?? { success: true }) };
  }
  return { session: { sessionEpoch: epoch.toString() }, correlationId, success: payload };
}

function deadlineMs(request: WireRequest): number | null {
  const deadline = request.metadata?.deadline;
  if (typeof deadline === 'string') {
    const value = Date.parse(deadline);
    return Number.isFinite(value) ? value : null;
  }
  if (!deadline?.seconds) return null;
  try {
    return Number(BigInt(deadline.seconds) * 1000n) + Math.floor((deadline.nanos ?? 0) / 1_000_000);
  } catch {
    return null;
  }
}

export function createOperationsHandler(
  config: RunnerGrpcConfig,
  sessions: RunnerGrpcSessionRegistry,
  options: OperationsHandlerOptions = {},
): RunnerGrpcHandler {
  const now = options.now ?? Date.now;
  const execute =
    options.execute ??
    ((context: RunnerGrpcCallContext, operation: OperationExecution) =>
      handleDataMessageWithAck(
        context.principal.runnerId,
        context.principal.userId,
        operation.request,
      ));
  const idempotency =
    options.idempotency ??
    new SqlOperationIdempotencyStore({ retentionMs: config.idempotencyRetentionMs });

  return (call: RunnerGrpcCall, context: RunnerGrpcCallContext) => {
    const active = new Set<AbortController>();
    let pending = 0;
    let closed = false;
    const cancelAll = () => {
      if (closed) return;
      closed = true;
      for (const controller of active) controller.abort('operations stream closed');
      active.clear();
    };
    call.once('cancelled', cancelAll);
    call.once('close', cancelAll);
    call.once('error', cancelAll);

    call.on('data', (request: WireRequest) => {
      void (async () => {
        const startedAt = now();
        const correlationId = request.metadata?.correlationId ?? '';
        let epoch: bigint;
        try {
          epoch = BigInt(request.session?.sessionEpoch ?? 0);
        } catch {
          epoch = 0n;
        }
        const operationKind = requestKind(request);
        const sendFailure = (code: FailureCode, message: string, retryable = false) => {
          if (!closed) call.write(failure(epoch, correlationId, code, message, retryable));
          observeRunnerGrpc({
            event: 'operation-failed',
            streamClass: 'operations',
            status: FailureCode[code] ?? String(code),
            runnerId: context.principal.runnerId,
            correlationId,
            sessionEpoch: epoch,
            queueDepth: pending,
            latencyMs: Math.max(0, now() - startedAt),
          });
        };

        if (!CORRELATION_ID_PATTERN.test(correlationId)) {
          sendFailure(FailureCode.INVALID_ARGUMENT, 'a valid operation correlation ID is required');
          return;
        }
        if (!sessions.isActive(context.principal.runnerId, epoch)) {
          sendFailure(FailureCode.UNAVAILABLE, 'runner session is not active', true);
          return;
        }
        const expiresAt = deadlineMs(request);
        if (expiresAt === null) {
          sendFailure(FailureCode.INVALID_ARGUMENT, 'an operation deadline is required');
          return;
        }
        if (expiresAt <= now()) {
          sendFailure(FailureCode.DEADLINE_EXCEEDED, 'operation deadline exceeded', true);
          return;
        }
        const kind = operationKind;
        const legacyRequest = kind
          ? toLegacyRequest(kind, request, context.principal.userId)
          : null;
        if (!kind || !legacyRequest) {
          sendFailure(FailureCode.INVALID_ARGUMENT, 'operation is not allowed');
          return;
        }
        const idempotencyKey = request.metadata?.idempotencyKey;
        const persistentMutation = PERSISTENT_MUTATIONS.has(kind);
        if (
          persistentMutation &&
          (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))
        ) {
          sendFailure(
            FailureCode.INVALID_ARGUMENT,
            'a valid idempotency key is required for persistent mutations',
          );
          return;
        }
        if (pending >= config.maxPendingOperations) {
          sendFailure(FailureCode.RESOURCE_EXHAUSTED, 'pending operation limit exceeded', true);
          return;
        }

        pending += 1;
        const controller = new AbortController();
        active.add(controller);
        const remainingMs = Math.max(1, expiresAt - now());
        const timer = setTimeout(
          () => controller.abort('operation deadline exceeded'),
          remainingMs,
        );
        timer.unref();
        try {
          const execution = persistentMutation
            ? idempotency.execute(
                {
                  runnerId: context.principal.runnerId,
                  operationKind: kind,
                  idempotencyKey: idempotencyKey!,
                  request: request[kind],
                },
                () => execute(context, { request: legacyRequest, signal: controller.signal }),
              )
            : execute(context, { request: legacyRequest, signal: controller.signal });
          const result = await Promise.race([
            execution,
            new Promise<never>((_, reject) => {
              controller.signal.addEventListener(
                'abort',
                () => reject(new Error(String(controller.signal.reason ?? 'operation cancelled'))),
                { once: true },
              );
            }),
          ]);
          if (closed) return;
          if (persistentMutation && (result as any).kind === 'conflict') {
            sendFailure(
              FailureCode.CONFLICT,
              'idempotency key was reused with a different request',
            );
            return;
          }
          if (persistentMutation && (result as any).kind === 'in_progress') {
            sendFailure(FailureCode.UNAVAILABLE, 'operation outcome is not available yet', true);
            return;
          }
          const operationResult = persistentMutation ? (result as any).outcome : result;
          if (!sessions.isActive(context.principal.runnerId, epoch)) {
            sendFailure(FailureCode.UNAVAILABLE, 'runner session was superseded', true);
          } else if (
            (operationResult as any)?.success === false &&
            (operationResult as any)?.error === 'Forbidden'
          ) {
            sendFailure(FailureCode.PERMISSION_DENIED, 'operation is not authorized');
          } else if (
            ((operationResult as any)?.type?.startsWith('data:get_thread') &&
              !(operationResult as any).thread) ||
            ((operationResult as any)?.type === 'data:get_tool_call_response' &&
              !(operationResult as any).toolCall) ||
            ((operationResult as any)?.type === 'data:find_tool_call_response' &&
              !(operationResult as any).toolCall)
          ) {
            sendFailure(FailureCode.NOT_FOUND, 'authorized resource was not found');
          } else {
            call.write(success(epoch, correlationId, operationResult));
            observeRunnerGrpc({
              event: 'operation-completed',
              streamClass: 'operations',
              status: 'ok',
              runnerId: context.principal.runnerId,
              correlationId,
              sessionEpoch: epoch,
              queueDepth: pending,
              latencyMs: Math.max(0, now() - startedAt),
            });
          }
        } catch (error) {
          if (closed) return;
          const deadlineExceeded = controller.signal.aborted && now() >= expiresAt;
          const cancelled = controller.signal.aborted && !deadlineExceeded;
          sendFailure(
            deadlineExceeded
              ? FailureCode.DEADLINE_EXCEEDED
              : cancelled
                ? FailureCode.CANCELLED
                : FailureCode.INTERNAL,
            deadlineExceeded
              ? 'operation deadline exceeded'
              : cancelled
                ? 'operation cancelled'
                : 'operation failed',
            deadlineExceeded,
          );
          log.warn('Runner gRPC operation did not complete', {
            namespace: 'runner-grpc',
            runnerId: context.principal.runnerId,
            correlationId,
            operation: kind,
            errorType: error instanceof Error ? error.name : 'unknown',
          });
        } finally {
          clearTimeout(timer);
          active.delete(controller);
          pending -= 1;
        }
      })();
    });
  };
}
