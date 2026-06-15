/**
 * Integration tests for data-handler.ts using the server DB singleton
 * backed by in-memory SQLite (same pattern as createTestApp).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { handleDataMessageWithAck } from '../../services/data-handler.js';
import { upsertProfile } from '../../services/profile-service.js';
import {
  seedProject,
  seedThread,
  seedMessage,
  seedToolCall,
  seedProjectMember,
  seedMessageQueue,
  seedRunner,
} from '../helpers/test-db.js';

describe('data-handler handleDataMessageWithAck', () => {
  let db: Awaited<ReturnType<typeof import('../../db/index.js')>>['db'];
  let schema: typeof import('../../db/schema.js');

  beforeAll(async () => {
    const { initDatabase } = await import('../../db/index.js');
    await initDatabase({ sqlitePath: ':memory:' });
    const { autoMigrate } = await import('../../db/migrate.js');
    await autoMigrate();
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = await import('../../db/schema.js');
  });

  beforeEach(() => {
    const tables = [
      'tool_calls',
      'messages',
      'message_queue',
      'stage_history',
      'thread_events',
      'threads',
      'agent_templates',
      'runner_project_assignments',
      'runner_tasks',
      'runners',
      'user_profiles',
      'project_members',
      'projects',
    ];
    for (const table of tables) {
      try {
        (db as any).run(`DELETE FROM ${table}`);
      } catch {
        // ignore
      }
    }
    seedProject(db as any, { id: 'p1', userId: 'user-1', path: '/tmp/repo' });
    seedThread(db as any, { id: 't1', projectId: 'p1', userId: 'user-1', title: 'Thread' });
  });

  afterAll(async () => {
    const { closeDatabase } = await import('../../db/index.js');
    await closeDatabase?.();
  });

  test('rejects cross-tenant userId on data:create_thread', async () => {
    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:create_thread',
      payload: { userId: 'user-2', threadId: 't-new', projectId: 'p1' },
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('insert_message persists and returns messageId', async () => {
    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:insert_message',
      threadId: 't1',
      payload: {
        threadId: 't1',
        role: 'assistant',
        content: 'Hello from runner',
      },
    });

    expect(res.type).toBe('data:insert_message_response');
    expect(res.messageId).toBeTruthy();

    const row = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, res.messageId))
      .get();
    expect(row?.content).toBe('Hello from runner');
  });

  test('get_thread returns thread for owner', async () => {
    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_thread',
      threadId: 't1',
    });

    expect(res.type).toBe('data:get_thread_response');
    expect(res.thread?.id).toBe('t1');
    expect(res.thread?.userId).toBe('user-1');
  });

  test('rejects get_thread for another user thread', async () => {
    seedThread(db as any, { id: 't2', projectId: 'p1', userId: 'user-2', title: 'Theirs' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_thread',
      threadId: 't2',
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('enqueue_message returns queued row', async () => {
    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:enqueue_message',
      threadId: 't1',
      payload: { content: 'queued prompt', model: 'sonnet' },
    });

    expect(res.type).toBe('data:enqueue_message_response');
    expect(res.queued?.content).toBe('queued prompt');
    expect(res.queued?.threadId).toBe('t1');
  });

  test('update_message requires message ownership', async () => {
    seedThread(db as any, { id: 't2', projectId: 'p1', userId: 'user-2', title: 'Theirs' });
    seedMessage(db as any, { id: 'm2', threadId: 't2', content: 'secret' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:update_message',
      threadId: 't2',
      payload: { messageId: 'm2', content: 'hacked' },
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('get_agent_template returns builtin template without user', async () => {
    const res = await handleDataMessageWithAck('runner-1', null, {
      type: 'data:get_agent_template',
      templateId: '__builtin__code-reviewer',
    });

    expect(res.type).toBe('data:get_agent_template_response');
    expect(res.template?.id).toBe('__builtin__code-reviewer');
  });

  test('get_agent_template returns null for unknown template id', async () => {
    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_agent_template',
      templateId: 'tpl-does-not-exist',
    });

    expect(res.type).toBe('data:get_agent_template_response');
    expect(res.template).toBeNull();
  });

  test('get_agent_template returns custom row from database', async () => {
    const now = new Date().toISOString();
    db.insert(schema.agentTemplates)
      .values({
        id: 'tpl-custom',
        userId: 'user-1',
        name: 'My Agent',
        systemPromptMode: 'prepend',
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_agent_template',
      templateId: 'tpl-custom',
    });

    expect(res.type).toBe('data:get_agent_template_response');
    expect(res.template?.id).toBe('tpl-custom');
    expect(res.template?.name).toBe('My Agent');
  });

  test('mark_and_list_stale_threads marks running threads interrupted', async () => {
    seedRunner(db as any, { id: 'runner-1', userId: 'user-1', token: 'token-runner-1' });
    seedRunner(db as any, { id: 'runner-2', userId: 'user-2', token: 'token-runner-2' });
    seedThread(db as any, {
      id: 'stale-1',
      projectId: 'p1',
      userId: 'user-1',
      status: 'running',
      runnerId: 'runner-1',
      provider: 'claude',
    });
    seedThread(db as any, {
      id: 'stale-2',
      projectId: 'p1',
      userId: 'user-1',
      status: 'running',
      runnerId: 'runner-1',
      provider: 'claude',
    });
    seedThread(db as any, {
      id: 'external-run',
      projectId: 'p1',
      userId: 'user-1',
      status: 'running',
      runnerId: 'runner-1',
      provider: 'external',
    });
    seedThread(db as any, {
      id: 'other-runner',
      projectId: 'p1',
      userId: 'user-1',
      status: 'running',
      runnerId: 'runner-2',
      provider: 'claude',
    });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:mark_and_list_stale_threads',
    });

    expect(res.type).toBe('data:mark_and_list_stale_threads_response');
    expect(res.threads.map((t: { id: string }) => t.id).sort()).toEqual(['stale-1', 'stale-2']);

    const stale1 = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, 'stale-1'))
      .get();
    expect(stale1?.status).toBe('interrupted');
    const external = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, 'external-run'))
      .get();
    expect(external?.status).toBe('running');
  });

  test('unknown type returns undefined', async () => {
    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:totally_unknown',
    });

    expect(res).toBeUndefined();
  });

  test('insert_tool_call persists and returns toolCallId', async () => {
    seedMessage(db as any, { id: 'm1', threadId: 't1', role: 'assistant', content: 'hi' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:insert_tool_call',
      threadId: 't1',
      payload: {
        messageId: 'm1',
        name: 'Read',
        input: JSON.stringify({ path: 'src/a.ts' }),
      },
    });

    expect(res.type).toBe('data:insert_tool_call_response');
    expect(res.toolCallId).toBeTruthy();

    const row = await db
      .select()
      .from(schema.toolCalls)
      .where(eq(schema.toolCalls.id, res.toolCallId))
      .get();
    expect(row?.name).toBe('Read');
  });

  test('get_tool_call returns tool call for owner', async () => {
    seedMessage(db as any, { id: 'm1', threadId: 't1' });
    seedToolCall(db as any, { id: 'tc-1', messageId: 'm1', name: 'Write' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_tool_call',
      toolCallId: 'tc-1',
    });

    expect(res.type).toBe('data:get_tool_call_response');
    expect(res.toolCall?.id).toBe('tc-1');
    expect(res.toolCall?.name).toBe('Write');
  });

  test('find_tool_call returns matching tool call by messageId, name, and input', async () => {
    const input = JSON.stringify({ file: 'src/a.ts' });
    seedMessage(db as any, { id: 'm1', threadId: 't1' });
    seedToolCall(db as any, { id: 'tc-find', messageId: 'm1', name: 'Read', input });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:find_tool_call',
      payload: { messageId: 'm1', name: 'Read', input },
    });

    expect(res.type).toBe('data:find_tool_call_response');
    expect(res.toolCall?.id).toBe('tc-find');
  });

  test('find_tool_call returns null when no match', async () => {
    seedMessage(db as any, { id: 'm1', threadId: 't1' });
    seedToolCall(db as any, {
      id: 'tc-1',
      messageId: 'm1',
      name: 'Read',
      input: JSON.stringify({ file: 'a.ts' }),
    });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:find_tool_call',
      payload: { messageId: 'm1', name: 'Write', input: '{}' },
    });

    expect(res.type).toBe('data:find_tool_call_response');
    expect(res.toolCall).toBeNull();
  });

  test('rejects find_tool_call for cross-tenant message', async () => {
    seedThread(db as any, { id: 't2', projectId: 'p1', userId: 'user-2', title: 'Theirs' });
    seedMessage(db as any, { id: 'm2', threadId: 't2' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:find_tool_call',
      payload: { messageId: 'm2', name: 'Read', input: '{}' },
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('find_last_unanswered_interactive_tool_call returns latest unanswered', async () => {
    seedMessage(db as any, {
      id: 'm-old',
      threadId: 't1',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    seedToolCall(db as any, {
      id: 'tc-old',
      messageId: 'm-old',
      name: 'AskUserQuestion',
      output: null,
    });
    seedMessage(db as any, {
      id: 'm-new',
      threadId: 't1',
      timestamp: '2026-01-02T00:00:00.000Z',
    });
    seedToolCall(db as any, {
      id: 'tc-new',
      messageId: 'm-new',
      name: 'ExitPlanMode',
      output: null,
    });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:find_last_unanswered_interactive_tool_call',
      threadId: 't1',
    });

    expect(res.type).toBe('data:find_last_unanswered_interactive_tool_call_response');
    expect(res.toolCall?.id).toBe('tc-new');
    expect(res.toolCall?.name).toBe('ExitPlanMode');
  });

  test('find_last_unanswered_interactive_tool_call returns null when all answered', async () => {
    seedMessage(db as any, { id: 'm1', threadId: 't1' });
    seedToolCall(db as any, {
      id: 'tc-1',
      messageId: 'm1',
      name: 'AskUserQuestion',
      output: 'user picked A',
    });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:find_last_unanswered_interactive_tool_call',
      threadId: 't1',
    });

    expect(res.type).toBe('data:find_last_unanswered_interactive_tool_call_response');
    expect(res.toolCall).toBeNull();
  });

  test('rejects find_last_unanswered_interactive_tool_call for foreign thread', async () => {
    seedThread(db as any, { id: 't2', projectId: 'p1', userId: 'user-2', title: 'Theirs' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:find_last_unanswered_interactive_tool_call',
      threadId: 't2',
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('rejects get_tool_call for cross-tenant tool call', async () => {
    seedThread(db as any, { id: 't2', projectId: 'p1', userId: 'user-2', title: 'Theirs' });
    seedMessage(db as any, { id: 'm2', threadId: 't2' });
    seedToolCall(db as any, { id: 'tc-2', messageId: 'm2' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_tool_call',
      toolCallId: 'tc-2',
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('update_tool_call_output persists output for owned tool call', async () => {
    seedMessage(db as any, { id: 'm1', threadId: 't1' });
    seedToolCall(db as any, { id: 'tc-1', messageId: 'm1', output: null });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:update_tool_call_output',
      threadId: 't1',
      payload: { toolCallId: 'tc-1', output: 'done' },
    });

    expect(res).toBeUndefined();

    const row = await db
      .select()
      .from(schema.toolCalls)
      .where(eq(schema.toolCalls.id, 'tc-1'))
      .get();
    expect(row?.output).toBe('done');
  });

  test('create_thread persists thread for runner user', async () => {
    const now = new Date().toISOString();
    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:create_thread',
      payload: {
        id: 't-new',
        projectId: 'p1',
        userId: 'user-1',
        title: 'From runner',
        mode: 'local',
        provider: 'claude',
        permissionMode: 'autoEdit',
        status: 'pending',
        model: 'sonnet',
        createdAt: now,
        updatedAt: now,
      },
    });

    expect(res).toEqual({ type: 'data:ack', success: true });

    const row = await db.select().from(schema.threads).where(eq(schema.threads.id, 't-new')).get();
    expect(row?.title).toBe('From runner');
    expect(row?.userId).toBe('user-1');
  });

  test('delete_thread removes thread owned by runner user', async () => {
    seedThread(db as any, { id: 't-del', projectId: 'p1', userId: 'user-1', title: 'Delete me' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:delete_thread',
      threadId: 't-del',
    });

    expect(res).toEqual({ type: 'data:ack', success: true });

    const row = await db.select().from(schema.threads).where(eq(schema.threads.id, 't-del')).get();
    expect(row).toBeUndefined();
  });

  test('rejects delete_thread for another user', async () => {
    seedThread(db as any, { id: 't2', projectId: 'p1', userId: 'user-2', title: 'Theirs' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:delete_thread',
      threadId: 't2',
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('delete_messages_after removes messages after anchor', async () => {
    seedMessage(db as any, {
      id: 'm1',
      threadId: 't1',
      content: 'one',
      timestamp: '2024-01-01T00:00:00.000Z',
    });
    seedMessage(db as any, {
      id: 'm2',
      threadId: 't1',
      content: 'two',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    seedMessage(db as any, {
      id: 'm3',
      threadId: 't1',
      content: 'three',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:delete_messages_after',
      threadId: 't1',
      payload: { threadId: 't1', anchorMessageId: 'm1' },
    });

    expect(res.type).toBe('data:delete_messages_after_response');
    expect(res.deletedCount).toBeGreaterThan(0);

    const remaining = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.threadId, 't1'))
      .all();
    expect(remaining.some((m) => m.id === 'm1')).toBe(true);
    expect(remaining.some((m) => m.id === 'm3')).toBe(false);
  });

  test('get_profile returns profile for user', async () => {
    await upsertProfile('user-1', { gitName: 'Test User', gitEmail: 'test@example.com' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_profile',
      userId: 'user-1',
    });

    expect(res.type).toBe('data:get_profile_response');
    expect(res.profile?.gitName).toBe('Test User');
    expect(res.profile?.gitEmail).toBe('test@example.com');
  });

  test('get_github_token returns stored token', async () => {
    await upsertProfile('user-1', { githubToken: 'ghp_test_token_123' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_github_token',
      userId: 'user-1',
    });

    expect(res.type).toBe('data:get_github_token_response');
    expect(res.token).toBe('ghp_test_token_123');
  });

  test('rejects get_github_token for mismatched userId', async () => {
    await upsertProfile('user-1', { githubToken: 'ghp_secret' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_github_token',
      userId: 'user-2',
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('builtin providers default to null (no override)', async () => {
    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_builtin_providers',
    });

    expect(res.type).toBe('data:get_builtin_providers_response');
    expect(res.active).toBeNull();
  });

  test('set_builtin_providers persists selection and survives reload', async () => {
    const setRes = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:set_builtin_providers',
      active: ['codex', 'gemini'],
    });
    expect(setRes).toEqual({ type: 'data:ack', success: true });

    // A second handler call simulates the runner fetching on startup after a
    // restart — the selection must come back instead of defaulting to all-on.
    const getRes = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_builtin_providers',
    });
    expect(getRes.type).toBe('data:get_builtin_providers_response');
    expect(getRes.active).toEqual(['codex', 'gemini']);
  });

  test('rejects set_builtin_providers for runner with no owning user', async () => {
    const res = await handleDataMessageWithAck('runner-1', null, {
      type: 'data:set_builtin_providers',
      active: ['codex'],
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('get_provider_key returns provider secret', async () => {
    await upsertProfile('user-1', { providerKey: { id: 'minimax', value: 'mm-key' } });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_provider_key',
      userId: 'user-1',
      provider: 'minimax',
    });

    expect(res.type).toBe('data:get_provider_key_response');
    expect(res.key).toBe('mm-key');
  });

  test('list_projects returns only projects owned by userId', async () => {
    seedProject(db as any, { id: 'p2', userId: 'user-1', name: 'Mine B', path: '/b' });
    seedProject(db as any, { id: 'p3', userId: 'user-2', name: 'Theirs', path: '/c' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:list_projects',
      userId: 'user-1',
    });

    expect(res.type).toBe('data:list_projects_response');
    expect(res.projects).toHaveLength(2);
    expect(res.projects.map((p: { id: string }) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  test('get_project returns project for owner', async () => {
    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_project',
      projectId: 'p1',
    });

    expect(res.type).toBe('data:get_project_response');
    expect(res.project?.id).toBe('p1');
    expect(res.project?.userId).toBe('user-1');
  });

  test('rejects get_project for foreign project', async () => {
    seedProject(db as any, { id: 'p-foreign', userId: 'user-2', path: '/other' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_project',
      projectId: 'p-foreign',
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('update_thread applies allowed field updates', async () => {
    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:update_thread',
      threadId: 't1',
      payload: {
        threadId: 't1',
        updates: { status: 'running', title: 'Renamed from runner' },
      },
    });

    expect(res).toEqual({ type: 'data:update_thread_response', ok: true });

    const row = await db.select().from(schema.threads).where(eq(schema.threads.id, 't1')).get();
    expect(row?.status).toBe('running');
    expect(row?.title).toBe('Renamed from runner');
  });

  test('rejects update_thread for another user thread', async () => {
    seedThread(db as any, { id: 't2', projectId: 'p1', userId: 'user-2', title: 'Theirs' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:update_thread',
      threadId: 't2',
      payload: { threadId: 't2', updates: { status: 'running' } },
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('list_project_threads returns non-archived threads for owned project', async () => {
    seedThread(db as any, { id: 't-active', projectId: 'p1', userId: 'user-1', archived: 0 });
    seedThread(db as any, {
      id: 't-archived',
      projectId: 'p1',
      userId: 'user-1',
      archived: 1,
      title: 'Old',
    });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:list_project_threads',
      projectId: 'p1',
    });

    expect(res.type).toBe('data:list_project_threads_response');
    const ids = res.threads.map((t: { id: string }) => t.id);
    expect(ids).toContain('t-active');
    expect(ids).toContain('t1');
    expect(ids).not.toContain('t-archived');
  });

  test('get_thread_messages returns paginated messages for owner', async () => {
    seedMessage(db as any, {
      id: 'm1',
      threadId: 't1',
      content: 'first',
      timestamp: '2024-01-01T00:00:00.000Z',
    });
    seedMessage(db as any, {
      id: 'm2',
      threadId: 't1',
      content: 'second',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_thread_messages',
      threadId: 't1',
      limit: 1,
    });

    expect(res.type).toBe('data:get_thread_messages_response');
    expect(res.messages).toHaveLength(1);
    expect(res.hasMore).toBe(true);
  });

  test('rejects get_thread_messages for foreign thread', async () => {
    seedThread(db as any, { id: 't2', projectId: 'p1', userId: 'user-2', title: 'Theirs' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_thread_messages',
      threadId: 't2',
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('search_threads finds messages by text, scoped to the runner user', async () => {
    seedThread(db as any, { id: 't2', projectId: 'p1', userId: 'user-2', title: 'Theirs' });
    seedMessage(db as any, {
      id: 'm-mine',
      threadId: 't1',
      content: 'deploy the pipeline today',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    seedMessage(db as any, {
      id: 'm-theirs',
      threadId: 't2',
      content: 'deploy the pipeline now',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:search_threads',
      query: 'pipeline',
    });

    expect(res.type).toBe('data:search_threads_response');
    const ids = res.results.map((r: { messageId: string }) => r.messageId);
    expect(ids).toContain('m-mine');
    expect(ids).not.toContain('m-theirs'); // cross-tenant isolation
    expect(res.results[0].threadTitle).toBe('Thread');
    expect(res.results[0].snippet).toContain('pipeline');
  });

  test('search_threads filters by time range', async () => {
    seedMessage(db as any, {
      id: 'm-old',
      threadId: 't1',
      content: 'old note',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    seedMessage(db as any, {
      id: 'm-new',
      threadId: 't1',
      content: 'new note',
      timestamp: '2026-06-01T00:00:00.000Z',
    });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:search_threads',
      since: '2026-01-01T00:00:00.000Z',
    });

    const ids = res.results.map((r: { messageId: string }) => r.messageId);
    expect(ids).toContain('m-new');
    expect(ids).not.toContain('m-old');
  });

  test('search_threads filters by author', async () => {
    db.insert(schema.messages)
      .values({
        id: 'm-auth',
        threadId: 't1',
        role: 'assistant',
        content: 'from claude',
        author: 'claude-opus-4-8',
        timestamp: '2026-02-01T00:00:00.000Z',
      })
      .run();
    db.insert(schema.messages)
      .values({
        id: 'm-noauth',
        threadId: 't1',
        role: 'user',
        content: 'from user',
        author: 'argenis',
        timestamp: '2026-02-01T00:00:01.000Z',
      })
      .run();

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:search_threads',
      author: 'claude',
    });

    const ids = res.results.map((r: { messageId: string }) => r.messageId);
    expect(ids).toContain('m-auth');
    expect(ids).not.toContain('m-noauth');
  });

  test('search_threads returns empty when no filter is provided', async () => {
    seedMessage(db as any, { id: 'm1', threadId: 't1', content: 'whatever' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:search_threads',
    });

    expect(res.type).toBe('data:search_threads_response');
    expect(res.results).toEqual([]);
  });

  test('resolve_project_path returns owner project path', async () => {
    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:resolve_project_path',
      projectId: 'p1',
      userId: 'user-1',
    });

    expect(res).toEqual({
      type: 'data:resolve_project_path_response',
      ok: true,
      path: '/tmp/repo',
    });
  });

  test('resolve_project_path returns member local path for shared project', async () => {
    seedProject(db as any, { id: 'p-shared', userId: 'user-2', path: '/owner/path' });
    seedProjectMember(db as any, {
      projectId: 'p-shared',
      userId: 'user-1',
      localPath: '/member/checkout',
    });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:resolve_project_path',
      projectId: 'p-shared',
      userId: 'user-1',
    });

    expect(res).toEqual({
      type: 'data:resolve_project_path_response',
      ok: true,
      path: '/member/checkout',
    });
  });

  test('rejects resolve_project_path for foreign project', async () => {
    seedProject(db as any, { id: 'p-foreign', userId: 'user-2', path: '/other' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:resolve_project_path',
      projectId: 'p-foreign',
      userId: 'user-1',
    });

    expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });
  });

  test('get_thread_with_messages returns thread and messages', async () => {
    seedMessage(db as any, { id: 'm1', threadId: 't1', content: 'hello' });

    const res = await handleDataMessageWithAck('runner-1', 'user-1', {
      type: 'data:get_thread_with_messages',
      threadId: 't1',
      messageLimit: 10,
    });

    expect(res.type).toBe('data:get_thread_with_messages_response');
    expect(res.thread?.id).toBe('t1');
    expect(res.thread?.messages?.length).toBeGreaterThanOrEqual(1);
  });

  describe('message queue via handleDataMessageWithAck', () => {
    test('queue_count returns zero for empty queue', async () => {
      const res = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:queue_count',
        threadId: 't1',
      });

      expect(res.type).toBe('data:queue_count_response');
      expect(res.count).toBe(0);
    });

    test('dequeue_message returns null when queue is empty', async () => {
      const res = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:dequeue_message',
        threadId: 't1',
      });

      expect(res.type).toBe('data:dequeue_message_response');
      expect(res.dequeued).toBeNull();
    });

    test('dequeue_message returns FIFO head and removes it', async () => {
      await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:enqueue_message',
        threadId: 't1',
        payload: { content: 'first' },
      });
      await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:enqueue_message',
        threadId: 't1',
        payload: { content: 'second' },
      });

      const dequeued = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:dequeue_message',
        threadId: 't1',
      });

      expect(dequeued.type).toBe('data:dequeue_message_response');
      expect(dequeued.dequeued?.content).toBe('first');

      const count = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:queue_count',
        threadId: 't1',
      });
      expect(count.count).toBe(1);
    });

    test('peek_message returns head without removing', async () => {
      await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:enqueue_message',
        threadId: 't1',
        payload: { content: 'peek-me' },
      });

      const peeked = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:peek_message',
        threadId: 't1',
      });

      expect(peeked.type).toBe('data:peek_message_response');
      expect(peeked.peeked?.content).toBe('peek-me');

      const count = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:queue_count',
        threadId: 't1',
      });
      expect(count.count).toBe(1);
    });

    test('list_queue returns items in sort order', async () => {
      await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:enqueue_message',
        threadId: 't1',
        payload: { content: 'A' },
      });
      await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:enqueue_message',
        threadId: 't1',
        payload: { content: 'B' },
      });

      const listed = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:list_queue',
        threadId: 't1',
      });

      expect(listed.type).toBe('data:list_queue_response');
      expect(listed.items.map((i: { content: string }) => i.content)).toEqual(['A', 'B']);
    });

    test('cancel_queued_message removes entry for owner', async () => {
      const queued = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:enqueue_message',
        threadId: 't1',
        payload: { content: 'cancel me' },
      });

      const res = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:cancel_queued_message',
        messageId: queued.queued.id,
      });

      expect(res.type).toBe('data:cancel_queued_message_response');
      expect(res.success).toBe(true);

      const count = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:queue_count',
        threadId: 't1',
      });
      expect(count.count).toBe(0);
    });

    test('update_queued_message changes content for owner', async () => {
      const queued = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:enqueue_message',
        threadId: 't1',
        payload: { content: 'old text' },
      });

      const res = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:update_queued_message',
        messageId: queued.queued.id,
        content: 'new text',
      });

      expect(res.type).toBe('data:update_queued_message_response');
      expect(res.updated?.content).toBe('new text');
    });

    test('rejects cancel_queued_message for cross-tenant queue row', async () => {
      seedThread(db as any, { id: 't2', projectId: 'p1', userId: 'user-2', title: 'Theirs' });
      const row = seedMessageQueue(db as any, {
        id: 'q-foreign',
        threadId: 't2',
        content: 'secret',
      });

      const res = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:cancel_queued_message',
        messageId: row.id,
      });

      expect(res).toEqual({ type: 'data:ack', success: false, error: 'Forbidden' });

      const stillThere = await db
        .select()
        .from(schema.messageQueue)
        .where(eq(schema.messageQueue.id, 'q-foreign'))
        .get();
      expect(stillThere).toBeTruthy();
    });
  });

  describe('data:search_threads', () => {
    test('matches by text and only within the runner-user threads', async () => {
      // Owned thread/messages.
      seedMessage(db as any, {
        id: 'm-own-1',
        threadId: 't1',
        role: 'user',
        content: 'detect faces at native resolution',
        timestamp: '2026-06-10T12:00:00Z',
      });
      // Foreign user's thread with the same term — must NOT leak.
      seedThread(db as any, { id: 't-foreign', projectId: 'p1', userId: 'user-2', title: 'Other' });
      seedMessage(db as any, {
        id: 'm-foreign-1',
        threadId: 't-foreign',
        role: 'user',
        content: 'detect faces elsewhere',
        timestamp: '2026-06-10T12:00:00Z',
      });

      const res = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:search_threads',
        query: 'faces',
      });

      expect(res.type).toBe('data:search_threads_response');
      expect(res.results).toHaveLength(1);
      expect(res.results[0].messageId).toBe('m-own-1');
      expect(res.results[0].threadId).toBe('t1');
      expect(res.results[0].snippet).toContain('faces');
    });

    test('filters by author and time range', async () => {
      seedMessage(db as any, {
        id: 'm-old',
        threadId: 't1',
        role: 'user',
        author: 'argenis',
        content: 'old note',
        timestamp: '2026-05-01T00:00:00Z',
      });
      seedMessage(db as any, {
        id: 'm-new-argenis',
        threadId: 't1',
        role: 'user',
        author: 'argenis',
        content: 'recent note',
        timestamp: '2026-06-10T00:00:00Z',
      });
      seedMessage(db as any, {
        id: 'm-new-other',
        threadId: 't1',
        role: 'assistant',
        author: 'opus',
        content: 'recent reply',
        timestamp: '2026-06-10T01:00:00Z',
      });

      const res = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:search_threads',
        author: 'argenis',
        since: '2026-06-01T00:00:00Z',
      });

      expect(res.results).toHaveLength(1);
      expect(res.results[0].messageId).toBe('m-new-argenis');
    });

    test('returns [] when no filter is given (never dumps full history)', async () => {
      seedMessage(db as any, { id: 'm-x', threadId: 't1', content: 'anything' });

      const res = await handleDataMessageWithAck('runner-1', 'user-1', {
        type: 'data:search_threads',
      });

      expect(res.results).toEqual([]);
    });
  });
});
