import type { JsonObject, JsonValue } from '@bufbuild/protobuf';
import { runAsync } from '@funny/shared/async';
import { FailureCode } from '@funny/shared/runner-v2/common';

import { log } from '../../lib/logger.js';
import { isNumber, isString } from '../../lib/value-guards.js';
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
import { decodeStruct, encodeStruct, type WireStruct } from './struct-codec.js';
import { observeRunnerGrpc } from './transport-observability.js';

type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * An `OperationsRequest` as proto-loader decodes it: the envelope fields, and
 * the request message under its operation's field name. Each operation message
 * is plain JSON (longs as strings, enums as numbers; operations.proto has no
 * bytes fields), with its `google.protobuf.Struct` fields still in wire form.
 */
type WireRequest = {
  operation?: string;
  session?: { sessionEpoch?: string | number | bigint };
  metadata?: {
    correlationId?: string;
    deadline?: { seconds?: string | number | bigint; nanos?: number };
    idempotencyKey?: string;
  };
} & { [K in OperationKind]?: JsonObject };

/** A field of a legacy data request: decoded JSON, or `undefined` for an absent optional field. */
type DataRequestValue =
  | JsonValue
  | undefined
  | DataRequestValue[]
  | { [key: string]: DataRequestValue };

/** The `data:*` message an operation becomes, handed to `handleDataMessageWithAck`. */
interface DataRequest {
  type: string;
  [field: string]: DataRequestValue;
}

/** `OperationSuccess`, one case of its `result` oneof. */
type OperationSuccessWire =
  | {
      threadMessages: {
        messages: WireStruct[];
        hasMore: boolean;
        hasMoreAfter: boolean;
        total?: string;
        windowStart?: string;
        leadingUserMessage?: WireStruct;
      };
    }
  | {
      toolCall: {
        id?: string;
        name?: string | null;
        input?: string | null;
        output?: string | null;
      };
    }
  | { thread: { value?: WireStruct } }
  | { insertedRecord: { id: string } }
  | { deletedRecords: { count: string } }
  | { operationResponse: WireStruct };

/** `OperationsResponse` as written to the stream. */
interface OperationsResponseWire {
  session: { sessionEpoch: string };
  correlationId: string;
  success?: OperationSuccessWire;
  failure?: { code: FailureCode; message: string; retryable: boolean };
}

export interface OperationExecution {
  request: DataRequest;
  signal: AbortSignal;
}

/**
 * What a data operation answers: a `data:*` response record (`{ success: false,
 * error }` on failure), or nothing for a plain ack.
 */
export type OperationOutcome = object | null | undefined;

export interface OperationsHandlerOptions {
  execute?: (
    context: RunnerGrpcCallContext,
    operation: OperationExecution,
  ) => Promise<OperationOutcome>;
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
  'activityStart',
  'activityUpdate',
  'activityReconcile',
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
  'getGithubAppToken',
  'getProjectSecrets',
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
  'activityStart',
  'activityUpdate',
  'activityReconcile',
  'factoryListRuns',
  'factoryControlRun',
  'factoryRequestApproval',
  'factoryGetRun',
] as const;

function requestKind(request: WireRequest): string | undefined {
  if (isString(request.operation)) return request.operation;
  return OPERATION_KINDS.find((key) => request[key] !== undefined);
}

type LegacyMapper = (value: JsonObject, principalUserId: string | null) => DataRequest;

const threadScoped =
  (type: string): LegacyMapper =>
  (value) => ({ type, threadId: value.threadId });
const payloadOf =
  (type: string): LegacyMapper =>
  (value) => ({ type, payload: value });
const threadPayloadOf =
  (type: string): LegacyMapper =>
  (value) => ({ type, threadId: value.threadId, payload: value });
const spreadOf =
  (type: string): LegacyMapper =>
  (value) => ({ type, ...value });
const principalScoped =
  (type: string): LegacyMapper =>
  (_value, principalUserId) => ({ type, userId: principalUserId });
const principalPayload =
  (type: string): LegacyMapper =>
  (_value, principalUserId) => ({ type, payload: { userId: principalUserId } });
const principalRulePayload =
  (type: string): LegacyMapper =>
  (value, principalUserId) => ({ type, payload: { ...value, userId: principalUserId } });
const emptyPayload =
  (type: string): LegacyMapper =>
  () => ({ type, payload: {} });
const threadIdPayload =
  (type: string): LegacyMapper =>
  (value) => ({ type, payload: { threadId: value.threadId } });
const threadRowPayload =
  (type: string, rowField: string): LegacyMapper =>
  (value) => ({ type, payload: { threadId: value.threadId, row: decodeStruct(value[rowField]) } });
const idPatchPayload =
  (type: string, idField: string): LegacyMapper =>
  (value) => ({ type, payload: { id: value[idField], patch: decodeStruct(value.patch) } });

function legacyInsertMessage(value: JsonObject): DataRequest {
  return {
    type: 'data:insert_message',
    threadId: value.threadId,
    payload: {
      threadId: value.threadId,
      role: value.role,
      // Proto3 omits non-optional scalar fields when they contain their
      // default value. An empty assistant placeholder is valid application
      // data, so restore the wire default instead of leaking `undefined`
      // into the persistence boundary.
      content: value.content ?? '',
      images: value.imagesJson ?? null,
      model: value.model ?? null,
      permissionMode: value.permissionMode ?? null,
      effort: value.effort ?? null,
      author: value.author ?? null,
      timestamp: value.timestamp ?? null,
    },
  };
}

function legacyMessagePageDirection(direction: JsonValue | undefined): 'after' | 'before' {
  return direction === 2 || direction === 'MESSAGE_PAGE_DIRECTION_AFTER' ? 'after' : 'before';
}

const LEGACY_MAPPERS: Record<OperationKind, LegacyMapper> = {
  getThread: threadScoped('data:get_thread'),
  getThreadByExternalRequestId: (value) => ({
    type: 'data:get_thread_by_external_request_id',
    externalRequestId: value.externalRequestId,
  }),
  getThreadByProviderSessionId: (value) => ({
    type: 'data:get_thread_by_session_id',
    sessionId: value.providerSessionId,
  }),
  getThreadWithMessages: spreadOf('data:get_thread_with_messages'),
  getThreadMessages: (value) => ({
    type: 'data:get_thread_messages',
    ...value,
    direction: legacyMessagePageDirection(value.direction),
  }),
  getToolCall: (value) => ({ type: 'data:get_tool_call', toolCallId: value.toolCallId }),
  findToolCall: payloadOf('data:find_tool_call'),
  insertMessage: legacyInsertMessage,
  insertToolCall: payloadOf('data:insert_tool_call'),
  updateThread: (value) => ({
    type: 'data:update_thread',
    threadId: value.threadId,
    payload: { threadId: value.threadId, updates: decodeStruct(value.updates) },
  }),
  updateMessage: payloadOf('data:update_message'),
  updateToolCallOutput: payloadOf('data:update_tool_call_output'),
  saveThreadEvent: (value) => ({
    type: 'data:save_thread_event',
    threadId: value.threadId,
    payload: { ...value, data: decodeStruct(value.data) },
  }),
  createPendingPermission: (value) => ({
    type: 'data:create_pending_permission_request',
    payload: decodeStruct(value.permission),
  }),
  resolvePendingPermission: (value) => ({
    type: 'data:resolve_pending_permission_request',
    payload: { requestId: value.permissionRequestId, decision: value.decision },
  }),
  expirePendingPermission: (value) => ({
    type: 'data:expire_pending_permission_request',
    payload: { requestId: value.permissionRequestId },
  }),
  insertComment: threadPayloadOf('data:insert_comment'),
  deleteMessagesAfter: threadPayloadOf('data:delete_messages_after'),
  searchThreads: spreadOf('data:search_threads'),
  findLastUnansweredInteractiveToolCall: threadScoped(
    'data:find_last_unanswered_interactive_tool_call',
  ),
  getProject: (value) => ({ type: 'data:get_project', projectId: value.projectId }),
  getStartupCommand: (value) => ({
    type: 'data:get_startup_command',
    cmdId: value.commandId,
    projectId: value.projectId,
  }),
  getAgentTemplate: (value) => ({ type: 'data:get_agent_template', templateId: value.templateId }),
  listProjects: principalScoped('data:list_projects'),
  listProjectThreads: (value) => ({
    type: 'data:list_project_threads',
    projectId: value.projectId,
  }),
  resolveProjectPath: (value, principalUserId) => ({
    type: 'data:resolve_project_path',
    projectId: value.projectId,
    userId: principalUserId,
  }),
  createProject: (value, principalUserId) => ({
    type: 'data:create_project',
    name: value.name,
    path: value.path,
    userId: principalUserId,
    orgId: value.organizationId ?? null,
  }),
  createThread: (value, principalUserId) => ({
    type: 'data:create_thread',
    payload: { ...decodeStruct(value.thread), userId: principalUserId },
  }),
  deleteThread: threadScoped('data:delete_thread'),
  enqueueMessage: (value) => ({
    type: 'data:enqueue_message',
    threadId: value.threadId,
    payload: decodeStruct(value.message),
  }),
  dequeueMessage: threadScoped('data:dequeue_message'),
  peekMessage: threadScoped('data:peek_message'),
  queueCount: threadScoped('data:queue_count'),
  listQueue: threadScoped('data:list_queue'),
  cancelQueuedMessage: (value) => ({
    type: 'data:cancel_queued_message',
    messageId: value.messageId,
  }),
  updateQueuedMessage: (value) => ({
    type: 'data:update_queued_message',
    messageId: value.messageId,
    content: value.content,
  }),
  getProfile: principalScoped('data:get_profile'),
  getProviderKey: (value, principalUserId) => ({
    type: 'data:get_provider_key',
    userId: principalUserId,
    provider: value.provider,
  }),
  getGithubToken: (value, principalUserId) => ({
    type: 'data:get_github_token',
    userId: principalUserId,
    projectId: value.projectId ?? undefined,
  }),
  getGithubAppToken: threadScoped('data:get_github_app_token'),
  factoryListRuns: threadScoped('data:factory_list_runs'),
  factoryControlRun: (value) => ({
    type: 'data:factory_control_run',
    threadId: value.threadId,
    runId: value.runId,
    action: value.action,
  }),
  factoryRequestApproval: (value) => ({
    type: 'data:factory_request_approval',
    threadId: value.threadId,
    runId: value.runId,
  }),
  factoryGetRun: (value) => ({
    type: 'data:factory_get_run',
    threadId: value.threadId,
    runId: value.runId,
  }),
  getProjectSecrets: threadScoped('data:get_project_secrets'),
  getMinimaxApiKey: principalScoped('data:get_minimax_api_key'),
  updateProfile: (value, principalUserId) => ({
    type: 'data:update_profile',
    userId: principalUserId,
    payload: decodeStruct(value.updates),
  }),
  resolveAgentExecutionProfile: (value, principalUserId) => ({
    type: 'data:resolve_agent_execution_profile',
    projectId: value.projectId,
    userId: principalUserId,
  }),
  getBuiltinProviders: () => ({ type: 'data:get_builtin_providers' }),
  setBuiltinProviders: (value) => ({
    type: 'data:set_builtin_providers',
    active: value.active ?? [],
  }),
  markAndListStaleThreads: () => ({ type: 'data:mark_and_list_stale_threads' }),
  watcherInsert: threadRowPayload('data:watcher_insert', 'watcher'),
  watcherGet: (value) => ({ type: 'data:watcher_get', payload: { id: value.watcherId } }),
  watcherGetLiveByThreadKey: (value) => ({
    type: 'data:watcher_get_live_by_thread_key',
    payload: { threadId: value.threadId, key: value.key },
  }),
  watcherListPending: emptyPayload('data:watcher_list_pending'),
  watcherListDue: (value) => ({
    type: 'data:watcher_list_due',
    payload: { now: Number(value.nowMs) },
  }),
  watcherListByUser: principalPayload('data:watcher_list_by_user'),
  watcherUpdate: (value) => ({
    type: 'data:watcher_update',
    payload: {
      id: value.watcherId,
      patch: decodeStruct(value.patch),
      expectedNextWakeAt:
        value.expectedNextWakeAtMs !== undefined ? Number(value.expectedNextWakeAtMs) : undefined,
    },
  }),
  watcherDeleteByThread: threadIdPayload('data:watcher_delete_by_thread'),
  jobInsert: threadRowPayload('data:job_insert', 'job'),
  jobGet: (value) => ({ type: 'data:job_get', payload: { id: value.jobId } }),
  jobListRunning: emptyPayload('data:job_list_running'),
  jobListByUser: principalPayload('data:job_list_by_user'),
  jobUpdate: idPatchPayload('data:job_update', 'jobId'),
  jobDeleteByThread: threadIdPayload('data:job_delete_by_thread'),
  createPermissionRule: principalRulePayload('data:create_permission_rule'),
  findPermissionRule: principalRulePayload('data:find_permission_rule'),
  listPermissionRules: principalRulePayload('data:list_permission_rules'),
  activityStart: (value) => ({
    type: 'data:activity_start',
    payload: decodeStruct(value.activity),
  }),
  activityUpdate: idPatchPayload('data:activity_update', 'activityId'),
  activityReconcile: (value) => ({
    type: 'data:activity_reconcile',
    payload: { liveIds: Array.isArray(value.liveActivityIds) ? value.liveActivityIds : [] },
  }),
};

// Single-entity lookups whose empty result maps to NOT_FOUND. Listed exactly:
// a `data:get_thread` prefix would also catch `data:get_thread_messages_response`,
// which carries `messages`, not `thread`.
const THREAD_LOOKUP_RESPONSES = new Set([
  'data:get_thread_response',
  'data:get_thread_by_external_request_id_response',
  'data:get_thread_by_session_id_response',
  'data:get_thread_with_messages_response',
]);
const TOOL_CALL_LOOKUP_RESPONSES = new Set([
  'data:get_tool_call_response',
  'data:find_tool_call_response',
]);

function isMissingLookup(result: any): boolean {
  if (THREAD_LOOKUP_RESPONSES.has(result?.type)) return !result.thread;
  if (TOOL_CALL_LOOKUP_RESPONSES.has(result?.type)) return !result.toolCall;
  return false;
}

function isOperationKind(kind: string): kind is OperationKind {
  return Object.hasOwn(LEGACY_MAPPERS, kind);
}

function toLegacyRequest(
  kind: OperationKind,
  request: WireRequest,
  principalUserId: string | null,
): DataRequest {
  return LEGACY_MAPPERS[kind](request[kind] ?? {}, principalUserId);
}

function failure(
  epoch: bigint,
  correlationId: string,
  code: FailureCode,
  message: string,
  retryable = false,
): OperationsResponseWire {
  return {
    session: { sessionEpoch: epoch.toString() },
    correlationId,
    failure: { code, message, retryable },
  };
}

function success(epoch: bigint, correlationId: string, result: any): OperationsResponseWire {
  let payload: OperationSuccessWire;
  if (result?.type === 'data:get_thread_messages_response') {
    payload = {
      threadMessages: {
        messages: (result.messages ?? []).map(encodeStruct),
        hasMore: !!result.hasMore,
        hasMoreAfter: !!result.hasMoreAfter,
        total: result.total !== undefined ? String(result.total) : undefined,
        windowStart: result.windowStart !== undefined ? String(result.windowStart) : undefined,
        leadingUserMessage: result.leadingUserMessage
          ? encodeStruct(result.leadingUserMessage)
          : undefined,
      },
    };
  } else if (
    result?.type === 'data:get_tool_call_response' ||
    result?.type === 'data:find_tool_call_response'
  ) {
    payload = { toolCall: result.toolCall ?? {} };
  } else if (result?.type?.startsWith('data:get_thread')) {
    payload = { thread: { value: result.thread ? encodeStruct(result.thread) : undefined } };
  } else if (isString(result?.messageId)) {
    payload = { insertedRecord: { id: result.messageId } };
  } else if (isString(result?.toolCallId)) {
    payload = { insertedRecord: { id: result.toolCallId } };
  } else if (isString(result?.commentId)) {
    payload = { insertedRecord: { id: result.commentId } };
  } else if (isNumber(result?.deletedCount)) {
    payload = { deletedRecords: { count: String(result.deletedCount) } };
  } else {
    payload = { operationResponse: encodeStruct(result ?? { success: true }) };
  }
  return { session: { sessionEpoch: epoch.toString() }, correlationId, success: payload };
}

function deadlineMs(request: WireRequest): number | null {
  const deadline = request.metadata?.deadline;
  if (isString(deadline)) {
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
        const kind = operationKind && isOperationKind(operationKind) ? operationKind : undefined;
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
          (!isString(idempotencyKey) || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))
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
          let operationResult: OperationOutcome;
          if (persistentMutation) {
            const execution = idempotency.execute(
              {
                runnerId: context.principal.runnerId,
                operationKind: kind,
                idempotencyKey: idempotencyKey!,
                request: request[kind],
              },
              () => execute(context, { request: legacyRequest, signal: controller.signal }),
            );
            const result = await runAsync(() => execution, { signal: controller.signal });
            if (closed) return;
            if (result.kind === 'conflict') {
              sendFailure(
                FailureCode.CONFLICT,
                'idempotency key was reused with a different request',
              );
              return;
            }
            if (result.kind === 'in_progress') {
              sendFailure(FailureCode.UNAVAILABLE, 'operation outcome is not available yet', true);
              return;
            }
            operationResult = result.outcome;
          } else {
            const execution = execute(context, {
              request: legacyRequest,
              signal: controller.signal,
            });
            operationResult = await runAsync(() => execution, { signal: controller.signal });
            if (closed) return;
          }
          // SAFETY: names only the two fields read below; optional chaining yields undefined for
          // nullish values, primitives and objects that lack them.
          const reported = operationResult as
            | { success?: unknown; error?: unknown }
            | null
            | undefined;
          if (!sessions.isActive(context.principal.runnerId, epoch)) {
            sendFailure(FailureCode.UNAVAILABLE, 'runner session was superseded', true);
          } else if (reported?.success === false) {
            const operationError = String(reported?.error ?? 'runner operation failed');
            sendFailure(
              operationError === 'Forbidden' ? FailureCode.PERMISSION_DENIED : FailureCode.INTERNAL,
              operationError === 'Forbidden' ? 'operation is not authorized' : operationError,
            );
          } else if (isMissingLookup(operationResult)) {
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
