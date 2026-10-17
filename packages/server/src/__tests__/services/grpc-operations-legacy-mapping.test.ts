import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { FailureCode } from '@funny/shared/runner-v2/common';

import { resolveRunnerGrpcConfig } from '../../services/grpc/config.js';
import { createOperationsHandler } from '../../services/grpc/operations-handler.js';
import type {
  RunnerGrpcCall,
  RunnerGrpcCallContext,
} from '../../services/grpc/runner-grpc-server.js';
import type { RunnerGrpcSessionRegistry } from '../../services/grpc/session-registry.js';

const struct = { fields: { a: { kind: 'stringValue', stringValue: 'x' } } };

const RICH_VALUE = {
  threadId: 't1',
  externalRequestId: 'ext1',
  providerSessionId: 'ps1',
  toolCallId: 'tc1',
  projectId: 'p1',
  templateId: 'tpl1',
  commandId: 'cmd1',
  messageId: 'm1',
  content: 'hi',
  role: 'user',
  imagesJson: '["img"]',
  model: 'sonnet',
  permissionMode: 'default',
  effort: 'high',
  author: 'me',
  timestamp: 'ts',
  provider: 'anthropic',
  permissionRequestId: 'pr1',
  decision: 'allow',
  name: 'n',
  path: '/p',
  organizationId: 'org',
  watcherId: 'w1',
  jobId: 'j1',
  key: 'k',
  nowMs: '123',
  direction: 2,
  active: ['a'],
  updates: struct,
  data: struct,
  permission: struct,
  thread: struct,
  message: struct,
  watcher: struct,
  job: struct,
  patch: struct,
};

type Outcome = { request?: Record<string, unknown>; failure?: { code: number; message: string } };

async function mapViaHandler(
  request: Record<string, unknown>,
  userId: string | null = 'user-1',
): Promise<Outcome> {
  const call = new EventEmitter() as EventEmitter & { write: (message: unknown) => void };
  let captured: Record<string, unknown> | undefined;
  const done = new Promise<Outcome>((resolve) => {
    call.write = (message: any) => {
      resolve(message.failure ? { failure: message.failure } : { request: captured });
    };
  });
  const handler = createOperationsHandler(
    resolveRunnerGrpcConfig({}),
    { isActive: () => true } as unknown as RunnerGrpcSessionRegistry,
    {
      execute: async (_context, operation) => {
        captured = operation.request;
        return { success: true };
      },
      idempotency: {
        execute: async (_input: unknown, run: () => Promise<unknown>) => ({
          kind: 'executed',
          outcome: await run(),
        }),
        cleanupExpired: async () => 0,
      } as any,
    },
  );
  const context: RunnerGrpcCallContext = {
    correlationId: 'stream-1',
    method: 'operations',
    principal: { runnerId: 'runner-1', userId, tenantId: null },
  };
  handler(call as unknown as RunnerGrpcCall, context);
  call.emit('data', {
    ...request,
    session: { sessionEpoch: '1' },
    metadata: {
      correlationId: 'corr-1',
      idempotencyKey: 'idem-1',
      deadline: { seconds: String(Math.floor(Date.now() / 1000) + 600) },
    },
  });
  return done;
}

const mapKind = async (kind: string, value: Record<string, unknown>) =>
  (await mapViaHandler({ operation: kind, [kind]: value })).request;

const decoded = { a: 'x' };

describe('operations handler legacy request mapping', () => {
  test('maps every operation kind with a fully populated value', async () => {
    const expected: Record<string, Record<string, unknown>> = {
      getThread: { type: 'data:get_thread', threadId: 't1' },
      getThreadByExternalRequestId: {
        type: 'data:get_thread_by_external_request_id',
        externalRequestId: 'ext1',
      },
      getThreadByProviderSessionId: { type: 'data:get_thread_by_session_id', sessionId: 'ps1' },
      getThreadWithMessages: { type: 'data:get_thread_with_messages', ...RICH_VALUE },
      getThreadMessages: {
        type: 'data:get_thread_messages',
        ...RICH_VALUE,
        direction: 'after',
      },
      getToolCall: { type: 'data:get_tool_call', toolCallId: 'tc1' },
      findToolCall: { type: 'data:find_tool_call', payload: RICH_VALUE },
      insertMessage: {
        type: 'data:insert_message',
        threadId: 't1',
        payload: {
          threadId: 't1',
          role: 'user',
          content: 'hi',
          images: '["img"]',
          model: 'sonnet',
          permissionMode: 'default',
          effort: 'high',
          author: 'me',
          timestamp: 'ts',
        },
      },
      insertToolCall: { type: 'data:insert_tool_call', payload: RICH_VALUE },
      updateThread: {
        type: 'data:update_thread',
        threadId: 't1',
        payload: { threadId: 't1', updates: decoded },
      },
      updateMessage: { type: 'data:update_message', payload: RICH_VALUE },
      updateToolCallOutput: { type: 'data:update_tool_call_output', payload: RICH_VALUE },
      saveThreadEvent: {
        type: 'data:save_thread_event',
        threadId: 't1',
        payload: { ...RICH_VALUE, data: decoded },
      },
      createPendingPermission: {
        type: 'data:create_pending_permission_request',
        payload: decoded,
      },
      resolvePendingPermission: {
        type: 'data:resolve_pending_permission_request',
        payload: { requestId: 'pr1', decision: 'allow' },
      },
      expirePendingPermission: {
        type: 'data:expire_pending_permission_request',
        payload: { requestId: 'pr1' },
      },
      insertComment: { type: 'data:insert_comment', threadId: 't1', payload: RICH_VALUE },
      deleteMessagesAfter: {
        type: 'data:delete_messages_after',
        threadId: 't1',
        payload: RICH_VALUE,
      },
      searchThreads: { type: 'data:search_threads', ...RICH_VALUE },
      findLastUnansweredInteractiveToolCall: {
        type: 'data:find_last_unanswered_interactive_tool_call',
        threadId: 't1',
      },
      getProject: { type: 'data:get_project', projectId: 'p1' },
      getStartupCommand: { type: 'data:get_startup_command', cmdId: 'cmd1', projectId: 'p1' },
      getAgentTemplate: { type: 'data:get_agent_template', templateId: 'tpl1' },
      listProjects: { type: 'data:list_projects', userId: 'user-1' },
      listProjectThreads: { type: 'data:list_project_threads', projectId: 'p1' },
      resolveProjectPath: {
        type: 'data:resolve_project_path',
        projectId: 'p1',
        userId: 'user-1',
      },
      createProject: {
        type: 'data:create_project',
        name: 'n',
        path: '/p',
        userId: 'user-1',
        orgId: 'org',
      },
      createThread: { type: 'data:create_thread', payload: { ...decoded, userId: 'user-1' } },
      deleteThread: { type: 'data:delete_thread', threadId: 't1' },
      enqueueMessage: { type: 'data:enqueue_message', threadId: 't1', payload: decoded },
      dequeueMessage: { type: 'data:dequeue_message', threadId: 't1' },
      peekMessage: { type: 'data:peek_message', threadId: 't1' },
      queueCount: { type: 'data:queue_count', threadId: 't1' },
      listQueue: { type: 'data:list_queue', threadId: 't1' },
      cancelQueuedMessage: { type: 'data:cancel_queued_message', messageId: 'm1' },
      updateQueuedMessage: {
        type: 'data:update_queued_message',
        messageId: 'm1',
        content: 'hi',
      },
      getProfile: { type: 'data:get_profile', userId: 'user-1' },
      getProviderKey: {
        type: 'data:get_provider_key',
        userId: 'user-1',
        provider: 'anthropic',
      },
      getGithubToken: { type: 'data:get_github_token', userId: 'user-1', projectId: 'p1' },
      getMinimaxApiKey: { type: 'data:get_minimax_api_key', userId: 'user-1' },
      updateProfile: { type: 'data:update_profile', userId: 'user-1', payload: decoded },
      resolveAgentExecutionProfile: {
        type: 'data:resolve_agent_execution_profile',
        projectId: 'p1',
        userId: 'user-1',
      },
      getBuiltinProviders: { type: 'data:get_builtin_providers' },
      setBuiltinProviders: { type: 'data:set_builtin_providers', active: ['a'] },
      markAndListStaleThreads: { type: 'data:mark_and_list_stale_threads' },
      watcherInsert: {
        type: 'data:watcher_insert',
        payload: { threadId: 't1', row: decoded },
      },
      watcherGet: { type: 'data:watcher_get', payload: { id: 'w1' } },
      watcherGetLiveByThreadKey: {
        type: 'data:watcher_get_live_by_thread_key',
        payload: { threadId: 't1', key: 'k' },
      },
      watcherListPending: { type: 'data:watcher_list_pending', payload: {} },
      watcherListDue: { type: 'data:watcher_list_due', payload: { now: 123 } },
      watcherListByUser: { type: 'data:watcher_list_by_user', payload: { userId: 'user-1' } },
      watcherUpdate: { type: 'data:watcher_update', payload: { id: 'w1', patch: decoded } },
      watcherDeleteByThread: {
        type: 'data:watcher_delete_by_thread',
        payload: { threadId: 't1' },
      },
      jobInsert: { type: 'data:job_insert', payload: { threadId: 't1', row: decoded } },
      jobGet: { type: 'data:job_get', payload: { id: 'j1' } },
      jobListRunning: { type: 'data:job_list_running', payload: {} },
      jobListByUser: { type: 'data:job_list_by_user', payload: { userId: 'user-1' } },
      jobUpdate: { type: 'data:job_update', payload: { id: 'j1', patch: decoded } },
      jobDeleteByThread: { type: 'data:job_delete_by_thread', payload: { threadId: 't1' } },
      createPermissionRule: {
        type: 'data:create_permission_rule',
        payload: { ...RICH_VALUE, userId: 'user-1' },
      },
      findPermissionRule: {
        type: 'data:find_permission_rule',
        payload: { ...RICH_VALUE, userId: 'user-1' },
      },
      listPermissionRules: {
        type: 'data:list_permission_rules',
        payload: { ...RICH_VALUE, userId: 'user-1' },
      },
    };
    for (const [kind, legacy] of Object.entries(expected)) {
      expect({ kind, legacy: await mapKind(kind, RICH_VALUE) }).toEqual({ kind, legacy });
    }
  });

  test('restores proto3 defaults for sparse values', async () => {
    expect(await mapKind('getThreadMessages', { threadId: 't1' })).toEqual({
      type: 'data:get_thread_messages',
      threadId: 't1',
      direction: 'before',
    });
    expect(
      await mapKind('getThreadMessages', {
        threadId: 't1',
        direction: 'MESSAGE_PAGE_DIRECTION_AFTER',
      }),
    ).toEqual({ type: 'data:get_thread_messages', threadId: 't1', direction: 'after' });
    expect(await mapKind('insertMessage', { threadId: 't1', role: 'assistant' })).toEqual({
      type: 'data:insert_message',
      threadId: 't1',
      payload: {
        threadId: 't1',
        role: 'assistant',
        content: '',
        images: null,
        model: null,
        permissionMode: null,
        effort: null,
        author: null,
        timestamp: null,
      },
    });
    expect(await mapKind('getGithubToken', {})).toEqual({
      type: 'data:get_github_token',
      userId: 'user-1',
    });
    expect(await mapKind('setBuiltinProviders', {})).toEqual({
      type: 'data:set_builtin_providers',
      active: [],
    });
    expect(await mapKind('createProject', { name: 'n', path: '/p' })).toEqual({
      type: 'data:create_project',
      name: 'n',
      path: '/p',
      userId: 'user-1',
      orgId: null,
    });
  });

  test('infers the operation kind from the populated oneof field', async () => {
    const outcome = await mapViaHandler({ getProject: { projectId: 'p9' } });
    expect(outcome.request).toEqual({ type: 'data:get_project', projectId: 'p9' });
  });

  test('rejects unknown operations, including prototype property names', async () => {
    for (const operation of ['notAnOperation', 'constructor', 'toString', '__proto__']) {
      const outcome = await mapViaHandler({ operation });
      expect({ operation, failure: outcome.failure }).toEqual({
        operation,
        failure: {
          code: FailureCode.INVALID_ARGUMENT,
          message: 'operation is not allowed',
          retryable: false,
        } as any,
      });
    }
  });
});
