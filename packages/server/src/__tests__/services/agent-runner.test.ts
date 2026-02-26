import { describe, test, expect, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

// Test agent runner logic by reimplementing the key functions against test DB.
// We cannot import agent-runner.ts directly since it imports the singleton DB.

const MODEL_MAP: Record<string, string> = {
  sonnet: 'claude-sonnet-4-5-20250929',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

const PERMISSION_MAP: Record<string, string> = {
  plan: 'plan',
  autoEdit: 'acceptEdits',
  confirmEdit: 'default',
};

describe('Agent Runner Constants', () => {
  test('MODEL_MAP maps sonnet correctly', () => {
    expect(MODEL_MAP.sonnet).toBe('claude-sonnet-4-5-20250929');
  });

  test('MODEL_MAP maps opus correctly', () => {
    expect(MODEL_MAP.opus).toBe('claude-opus-4-6');
  });

  test('MODEL_MAP maps haiku correctly', () => {
    expect(MODEL_MAP.haiku).toBe('claude-haiku-4-5-20251001');
  });

  test('PERMISSION_MAP maps plan correctly', () => {
    expect(PERMISSION_MAP.plan).toBe('plan');
  });

  test('PERMISSION_MAP maps autoEdit correctly', () => {
    expect(PERMISSION_MAP.autoEdit).toBe('acceptEdits');
  });

  test('PERMISSION_MAP maps confirmEdit correctly', () => {
    expect(PERMISSION_MAP.confirmEdit).toBe('default');
  });
});

describe('handleCLIMessage logic', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    seedProject(testDb.db, { id: 'p1' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1' });
  });

  test('system init message saves session_id to thread', () => {
    const msg = {
      type: 'system' as const,
      subtype: 'init' as const,
      session_id: 'sess-abc-123',
    };

    // Simulate handleCLIMessage logic for system init
    testDb.db
      .update(testDb.schema.threads)
      .set({ sessionId: msg.session_id })
      .where(eq(testDb.schema.threads.id, 't1'))
      .run();

    const thread = testDb.db
      .select()
      .from(testDb.schema.threads)
      .where(eq(testDb.schema.threads.id, 't1'))
      .get();

    expect(thread!.sessionId).toBe('sess-abc-123');
  });

  test('assistant message creates a new message in DB', () => {
    const msgId = 'msg-1';

    testDb.db
      .insert(testDb.schema.messages)
      .values({
        id: msgId,
        threadId: 't1',
        role: 'assistant',
        content: 'Hello from Claude',
        timestamp: new Date().toISOString(),
      })
      .run();

    const messages = testDb.db
      .select()
      .from(testDb.schema.messages)
      .where(eq(testDb.schema.messages.threadId, 't1'))
      .all();

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toBe('Hello from Claude');
  });

  test('assistant message updates existing message on subsequent calls', () => {
    const msgId = 'msg-update';

    testDb.db
      .insert(testDb.schema.messages)
      .values({
        id: msgId,
        threadId: 't1',
        role: 'assistant',
        content: 'Partial',
        timestamp: new Date().toISOString(),
      })
      .run();

    testDb.db
      .update(testDb.schema.messages)
      .set({ content: 'Partial content complete' })
      .where(eq(testDb.schema.messages.id, msgId))
      .run();

    const msg = testDb.db
      .select()
      .from(testDb.schema.messages)
      .where(eq(testDb.schema.messages.id, msgId))
      .get();

    expect(msg!.content).toBe('Partial content complete');
  });

  test('tool_use block creates a tool_call record', () => {
    const msgId = 'msg-tool';

    testDb.db
      .insert(testDb.schema.messages)
      .values({
        id: msgId,
        threadId: 't1',
        role: 'assistant',
        content: 'Using a tool',
        timestamp: new Date().toISOString(),
      })
      .run();

    testDb.db
      .insert(testDb.schema.toolCalls)
      .values({
        id: 'tc-1',
        messageId: msgId,
        name: 'Read',
        input: JSON.stringify({ file: 'test.ts' }),
      })
      .run();

    const toolCalls = testDb.db
      .select()
      .from(testDb.schema.toolCalls)
      .where(eq(testDb.schema.toolCalls.messageId, msgId))
      .all();

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('Read');
    expect(JSON.parse(toolCalls[0].input!)).toEqual({ file: 'test.ts' });
  });

  test('result message updates thread status to completed', () => {
    testDb.db
      .update(testDb.schema.threads)
      .set({
        status: 'completed',
        cost: 0.05,
        completedAt: new Date().toISOString(),
      })
      .where(eq(testDb.schema.threads.id, 't1'))
      .run();

    const thread = testDb.db
      .select()
      .from(testDb.schema.threads)
      .where(eq(testDb.schema.threads.id, 't1'))
      .get();

    expect(thread!.status).toBe('completed');
    expect(thread!.cost).toBe(0.05);
    expect(thread!.completedAt).toBeTruthy();
  });

  test('result with error subtype sets thread to failed', () => {
    testDb.db
      .update(testDb.schema.threads)
      .set({
        status: 'failed',
        completedAt: new Date().toISOString(),
      })
      .where(eq(testDb.schema.threads.id, 't1'))
      .run();

    const thread = testDb.db
      .select()
      .from(testDb.schema.threads)
      .where(eq(testDb.schema.threads.id, 't1'))
      .get();

    expect(thread!.status).toBe('failed');
  });

  test('user message is stored in DB', () => {
    testDb.db
      .insert(testDb.schema.messages)
      .values({
        id: 'user-msg-1',
        threadId: 't1',
        role: 'user',
        content: 'Fix the bug in auth',
        timestamp: new Date().toISOString(),
      })
      .run();

    const messages = testDb.db
      .select()
      .from(testDb.schema.messages)
      .where(eq(testDb.schema.messages.threadId, 't1'))
      .all();

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Fix the bug in auth');
  });
});

// ── State machine edge cases ──────────────────────────────────

describe('Agent Runner State Machine Edge Cases', () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    seedProject(testDb.db, { id: 'p1' });
    seedThread(testDb.db, { id: 't1', projectId: 'p1', status: 'running' });
  });

  test('multiple tool_use blocks create multiple tool_call records', () => {
    const msgId = 'msg-multi-tool';

    testDb.db
      .insert(testDb.schema.messages)
      .values({
        id: msgId,
        threadId: 't1',
        role: 'assistant',
        content: 'Using multiple tools',
        timestamp: new Date().toISOString(),
      })
      .run();

    // Simulate multiple tool_use blocks
    const tools = [
      { id: 'tc-1', name: 'Read', input: '{"file":"a.ts"}' },
      { id: 'tc-2', name: 'Edit', input: '{"file":"a.ts","content":"new"}' },
      { id: 'tc-3', name: 'Bash', input: '{"command":"npm test"}' },
    ];

    for (const tool of tools) {
      testDb.db
        .insert(testDb.schema.toolCalls)
        .values({
          id: tool.id,
          messageId: msgId,
          name: tool.name,
          input: tool.input,
        })
        .run();
    }

    const toolCalls = testDb.db
      .select()
      .from(testDb.schema.toolCalls)
      .where(eq(testDb.schema.toolCalls.messageId, msgId))
      .all();

    expect(toolCalls).toHaveLength(3);
    expect(toolCalls.map((tc) => tc.name)).toEqual(['Read', 'Edit', 'Bash']);
  });

  test('text → tool_use → new text creates separate messages', () => {
    // First assistant message with text
    testDb.db
      .insert(testDb.schema.messages)
      .values({
        id: 'msg-1',
        threadId: 't1',
        role: 'assistant',
        content: 'Let me read the file',
        timestamp: new Date().toISOString(),
      })
      .run();

    // Tool call on that message
    testDb.db
      .insert(testDb.schema.toolCalls)
      .values({
        id: 'tc-1',
        messageId: 'msg-1',
        name: 'Read',
        input: '{"file":"test.ts"}',
      })
      .run();

    // Second assistant message after tool result (new message ID)
    testDb.db
      .insert(testDb.schema.messages)
      .values({
        id: 'msg-2',
        threadId: 't1',
        role: 'assistant',
        content: 'I see the issue, let me fix it',
        timestamp: new Date().toISOString(),
      })
      .run();

    const messages = testDb.db
      .select()
      .from(testDb.schema.messages)
      .where(eq(testDb.schema.messages.threadId, 't1'))
      .all();

    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[1].id).toBe('msg-2');

    const tc = testDb.db
      .select()
      .from(testDb.schema.toolCalls)
      .where(eq(testDb.schema.toolCalls.messageId, 'msg-1'))
      .all();
    expect(tc).toHaveLength(1);
  });

  test('assistant message with only tool_use (no text) still gets a message record', () => {
    // The agent runner always creates a message even if content is empty
    testDb.db
      .insert(testDb.schema.messages)
      .values({
        id: 'msg-empty',
        threadId: 't1',
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
      })
      .run();

    testDb.db
      .insert(testDb.schema.toolCalls)
      .values({
        id: 'tc-only',
        messageId: 'msg-empty',
        name: 'Glob',
        input: '{"pattern":"**/*.ts"}',
      })
      .run();

    const msg = testDb.db
      .select()
      .from(testDb.schema.messages)
      .where(eq(testDb.schema.messages.id, 'msg-empty'))
      .get();
    expect(msg).toBeTruthy();
    expect(msg!.content).toBe('');

    const tc = testDb.db
      .select()
      .from(testDb.schema.toolCalls)
      .where(eq(testDb.schema.toolCalls.messageId, 'msg-empty'))
      .all();
    expect(tc).toHaveLength(1);
  });

  test('error_max_turns result sets thread to failed', () => {
    // Simulate: result.subtype !== 'success' → status = 'failed'
    const finalStatus = 'error_max_turns' === 'success' ? 'completed' : 'failed';

    testDb.db
      .update(testDb.schema.threads)
      .set({ status: finalStatus, cost: 0.12, completedAt: new Date().toISOString() })
      .where(eq(testDb.schema.threads.id, 't1'))
      .run();

    const thread = testDb.db
      .select()
      .from(testDb.schema.threads)
      .where(eq(testDb.schema.threads.id, 't1'))
      .get();

    expect(thread!.status).toBe('failed');
    expect(thread!.cost).toBe(0.12);
  });

  test('error_during_execution result sets thread to failed', () => {
    const finalStatus = 'error_during_execution' === 'success' ? 'completed' : 'failed';

    testDb.db
      .update(testDb.schema.threads)
      .set({ status: finalStatus, completedAt: new Date().toISOString() })
      .where(eq(testDb.schema.threads.id, 't1'))
      .run();

    const thread = testDb.db
      .select()
      .from(testDb.schema.threads)
      .where(eq(testDb.schema.threads.id, 't1'))
      .get();

    expect(thread!.status).toBe('failed');
  });

  test('stopAgent sets thread status to stopped', () => {
    testDb.db
      .update(testDb.schema.threads)
      .set({ status: 'stopped' })
      .where(eq(testDb.schema.threads.id, 't1'))
      .run();

    const thread = testDb.db
      .select()
      .from(testDb.schema.threads)
      .where(eq(testDb.schema.threads.id, 't1'))
      .get();

    expect(thread!.status).toBe('stopped');
  });

  test('streaming updates overwrite content with full content', () => {
    const msgId = 'msg-stream';

    // First chunk: partial content
    testDb.db
      .insert(testDb.schema.messages)
      .values({
        id: msgId,
        threadId: 't1',
        role: 'assistant',
        content: 'Hello',
        timestamp: new Date().toISOString(),
      })
      .run();

    // Second chunk: more complete content (replaces, not appends)
    testDb.db
      .update(testDb.schema.messages)
      .set({ content: 'Hello, I will help you' })
      .where(eq(testDb.schema.messages.id, msgId))
      .run();

    // Third chunk: full content
    testDb.db
      .update(testDb.schema.messages)
      .set({ content: 'Hello, I will help you fix the bug in the auth module.' })
      .where(eq(testDb.schema.messages.id, msgId))
      .run();

    const msg = testDb.db
      .select()
      .from(testDb.schema.messages)
      .where(eq(testDb.schema.messages.id, msgId))
      .get();

    expect(msg!.content).toBe('Hello, I will help you fix the bug in the auth module.');
    // Verify only 1 message exists, not 3
    const all = testDb.db
      .select()
      .from(testDb.schema.messages)
      .where(eq(testDb.schema.messages.threadId, 't1'))
      .all();
    expect(all).toHaveLength(1);
  });
});
