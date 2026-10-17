import { describe, expect, test } from 'vitest';

import {
  RUNNER_OPERATION_EVENT_TYPES,
  mapRunnerOperation,
  mapRunnerOperationOutcome,
  normalizeRunnerOperationValue,
} from '../../services/grpc-operations-adapter.js';

describe('GrpcOperationsAdapter mapping', () => {
  test('maps every declared application operation to exactly one protobuf field', () => {
    const mappings = RUNNER_OPERATION_EVENT_TYPES.map((eventType) =>
      mapRunnerOperation(eventType, { payload: {} }),
    );
    expect(mappings).toHaveLength(RUNNER_OPERATION_EVENT_TYPES.length);
    expect(mappings.every(({ kind }) => typeof kind === 'string' && kind.length > 0)).toBe(true);
  });

  test('maps each application operation to its exact protobuf kind and value', () => {
    const P = {
      threadId: 'pt1',
      updates: { a: 1 },
      requestId: 'r1',
      decision: 'allow',
      id: 'i1',
      row: { r: 1 },
      patch: { x: 1 },
      now: 5,
    };
    const I = {
      threadId: 't1',
      externalRequestId: 'ext1',
      sessionId: 's1',
      toolCallId: 'tc1',
      projectId: 'p1',
      cmdId: 'c1',
      templateId: 'tpl1',
      name: 'n',
      path: '/p',
      orgId: 'org',
      messageId: 'm1',
      content: 'hi',
      provider: 'anthropic',
      active: ['a'],
      direction: 'after',
      payload: P,
    };
    const expected: Record<string, { kind: string; value: Record<string, unknown> }> = {
      'data:get_thread': { kind: 'getThread', value: { threadId: 't1' } },
      'data:get_thread_by_external_request_id': {
        kind: 'getThreadByExternalRequestId',
        value: { externalRequestId: 'ext1' },
      },
      'data:get_thread_by_session_id': {
        kind: 'getThreadByProviderSessionId',
        value: { providerSessionId: 's1' },
      },
      'data:get_thread_with_messages': { kind: 'getThreadWithMessages', value: I },
      'data:get_thread_messages': { kind: 'getThreadMessages', value: { ...I, direction: 2 } },
      'data:get_tool_call': { kind: 'getToolCall', value: { toolCallId: 'tc1' } },
      'data:find_tool_call': { kind: 'findToolCall', value: P },
      'data:insert_message': { kind: 'insertMessage', value: P },
      'data:insert_tool_call': { kind: 'insertToolCall', value: P },
      'data:update_thread': { kind: 'updateThread', value: { threadId: 'pt1', updates: { a: 1 } } },
      'data:update_message': { kind: 'updateMessage', value: P },
      'data:update_tool_call_output': { kind: 'updateToolCallOutput', value: P },
      'data:save_thread_event': { kind: 'saveThreadEvent', value: P },
      'data:create_pending_permission_request': {
        kind: 'createPendingPermission',
        value: { permission: P },
      },
      'data:resolve_pending_permission_request': {
        kind: 'resolvePendingPermission',
        value: { permissionRequestId: 'r1', decision: 'allow' },
      },
      'data:expire_pending_permission_request': {
        kind: 'expirePendingPermission',
        value: { permissionRequestId: 'r1' },
      },
      'data:insert_comment': { kind: 'insertComment', value: P },
      'data:delete_messages_after': { kind: 'deleteMessagesAfter', value: P },
      'data:search_threads': { kind: 'searchThreads', value: I },
      'data:find_last_unanswered_interactive_tool_call': {
        kind: 'findLastUnansweredInteractiveToolCall',
        value: { threadId: 't1' },
      },
      'data:get_project': { kind: 'getProject', value: { projectId: 'p1' } },
      'data:get_startup_command': {
        kind: 'getStartupCommand',
        value: { commandId: 'c1', projectId: 'p1' },
      },
      'data:get_agent_template': { kind: 'getAgentTemplate', value: { templateId: 'tpl1' } },
      'data:list_projects': { kind: 'listProjects', value: {} },
      'data:list_project_threads': { kind: 'listProjectThreads', value: { projectId: 'p1' } },
      'data:resolve_project_path': { kind: 'resolveProjectPath', value: { projectId: 'p1' } },
      'data:create_project': {
        kind: 'createProject',
        value: { name: 'n', path: '/p', organizationId: 'org' },
      },
      'data:create_thread': { kind: 'createThread', value: { thread: P } },
      'data:delete_thread': { kind: 'deleteThread', value: { threadId: 't1' } },
      'data:enqueue_message': { kind: 'enqueueMessage', value: { threadId: 't1', message: P } },
      'data:dequeue_message': { kind: 'dequeueMessage', value: { threadId: 't1' } },
      'data:peek_message': { kind: 'peekMessage', value: { threadId: 't1' } },
      'data:queue_count': { kind: 'queueCount', value: { threadId: 't1' } },
      'data:list_queue': { kind: 'listQueue', value: { threadId: 't1' } },
      'data:cancel_queued_message': { kind: 'cancelQueuedMessage', value: { messageId: 'm1' } },
      'data:update_queued_message': {
        kind: 'updateQueuedMessage',
        value: { messageId: 'm1', content: 'hi' },
      },
      'data:get_profile': { kind: 'getProfile', value: {} },
      'data:get_provider_key': { kind: 'getProviderKey', value: { provider: 'anthropic' } },
      'data:get_github_token': { kind: 'getGithubToken', value: { projectId: 'p1' } },
      'data:get_minimax_api_key': { kind: 'getMinimaxApiKey', value: {} },
      'data:update_profile': { kind: 'updateProfile', value: { updates: P } },
      'data:resolve_agent_execution_profile': {
        kind: 'resolveAgentExecutionProfile',
        value: { projectId: 'p1' },
      },
      'data:get_builtin_providers': { kind: 'getBuiltinProviders', value: {} },
      'data:set_builtin_providers': { kind: 'setBuiltinProviders', value: { active: ['a'] } },
      'data:mark_and_list_stale_threads': { kind: 'markAndListStaleThreads', value: {} },
      'data:watcher_insert': {
        kind: 'watcherInsert',
        value: { threadId: 'pt1', watcher: { r: 1 } },
      },
      'data:watcher_get': { kind: 'watcherGet', value: { watcherId: 'i1' } },
      'data:watcher_get_live_by_thread_key': { kind: 'watcherGetLiveByThreadKey', value: P },
      'data:watcher_list_pending': { kind: 'watcherListPending', value: {} },
      'data:watcher_list_due': { kind: 'watcherListDue', value: { nowMs: '5' } },
      'data:watcher_list_by_user': { kind: 'watcherListByUser', value: {} },
      'data:watcher_update': {
        kind: 'watcherUpdate',
        value: { watcherId: 'i1', patch: { x: 1 } },
      },
      'data:watcher_delete_by_thread': {
        kind: 'watcherDeleteByThread',
        value: { threadId: 'pt1' },
      },
      'data:job_insert': { kind: 'jobInsert', value: { threadId: 'pt1', job: { r: 1 } } },
      'data:job_get': { kind: 'jobGet', value: { jobId: 'i1' } },
      'data:job_list_running': { kind: 'jobListRunning', value: {} },
      'data:job_list_by_user': { kind: 'jobListByUser', value: {} },
      'data:job_update': { kind: 'jobUpdate', value: { jobId: 'i1', patch: { x: 1 } } },
      'data:job_delete_by_thread': { kind: 'jobDeleteByThread', value: { threadId: 'pt1' } },
      'data:create_permission_rule': { kind: 'createPermissionRule', value: P },
      'data:find_permission_rule': { kind: 'findPermissionRule', value: P },
      'data:list_permission_rules': { kind: 'listPermissionRules', value: P },
    };
    expect(Object.keys(expected).sort()).toEqual([...RUNNER_OPERATION_EVENT_TYPES].sort());
    for (const eventType of RUNNER_OPERATION_EVENT_TYPES) {
      expect({ eventType, mapped: mapRunnerOperation(eventType, I) }).toEqual({
        eventType,
        mapped: expected[eventType],
      });
    }
  });

  test('falls back to the input as payload and fills operation defaults', () => {
    expect(mapRunnerOperation('data:insert_tool_call', { toolCallId: 'tc1' })).toEqual({
      kind: 'insertToolCall',
      value: { toolCallId: 'tc1' },
    });
    expect(mapRunnerOperation('data:get_github_token', {})).toEqual({
      kind: 'getGithubToken',
      value: { projectId: '' },
    });
    expect(mapRunnerOperation('data:get_thread_messages', { threadId: 't1' })).toEqual({
      kind: 'getThreadMessages',
      value: { threadId: 't1', direction: 1 },
    });
  });

  test('projects legacy and principal-derived fields before protobuf encoding', () => {
    expect(
      normalizeRunnerOperationValue('insertMessage', {
        threadId: 'thread-1',
        role: 'assistant',
        content: 'hello',
        images: ['a'],
        ignored: undefined,
      }),
    ).toEqual({
      threadId: 'thread-1',
      role: 'assistant',
      content: 'hello',
      imagesJson: ['a'],
    });
    expect(
      normalizeRunnerOperationValue('createPermissionRule', {
        userId: 'untrusted',
        projectPath: '/repo',
        toolName: 'Bash',
        decision: 'allow',
      }),
    ).toEqual({ projectPath: '/repo', toolName: 'Bash', decision: 'allow' });
  });

  test('replaces unpaired UTF-16 surrogates before protobuf encoding', () => {
    expect(
      normalizeRunnerOperationValue('updateToolCallOutput', {
        toolCallId: 'tool-1',
        output: `before\uD800-middle-\uDFFF-after-😀`,
      }),
    ).toEqual({
      toolCallId: 'tool-1',
      output: 'before�-middle-�-after-😀',
    });
  });

  test('maps all supported outcome envelopes back to facade results', () => {
    expect(
      mapRunnerOperationOutcome('getThread', {
        thread: { value: { id: 'thread-1' } },
      }),
    ).toEqual({ type: 'data:get_thread_response', thread: { id: 'thread-1' } });
    expect(
      mapRunnerOperationOutcome('insertMessage', {
        insertedRecord: { id: 'message-1' },
      }),
    ).toEqual({ messageId: 'message-1' });
    expect(
      mapRunnerOperationOutcome('insertToolCall', {
        insertedRecord: { id: 'tool-1' },
      }),
    ).toEqual({ toolCallId: 'tool-1' });
    expect(
      mapRunnerOperationOutcome('deleteMessagesAfter', {
        deletedRecords: { count: '3' },
      }),
    ).toEqual({ deletedCount: 3 });
    expect(mapRunnerOperationOutcome('custom', { operationResponse: { value: 1 } })).toEqual({
      value: 1,
    });
  });
});
