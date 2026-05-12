import { describe, test, expect, beforeEach } from 'bun:test';

import { createMessageRepository } from '../../repositories/message-repository.js';
import {
  createTestDb,
  seedProject,
  seedThread,
  seedMessage,
  seedToolCall,
} from '../helpers/test-db.js';

/** Build an ISO timestamp `i` seconds after a fixed base, so message order is deterministic. */
function ts(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
}

let deps: ReturnType<typeof createTestDb>;
let repo: ReturnType<typeof createMessageRepository>;

beforeEach(() => {
  deps = createTestDb();
  repo = createMessageRepository(deps);
  seedProject(deps.db);
  seedThread(deps.db);
});

describe('insertMessage', () => {
  test('returns a generated ID', async () => {
    const id = await repo.insertMessage({ threadId: 't1', role: 'user', content: 'hello' });
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  test('generates unique IDs', async () => {
    const id1 = await repo.insertMessage({ threadId: 't1', role: 'user', content: 'a' });
    const id2 = await repo.insertMessage({ threadId: 't1', role: 'user', content: 'b' });
    expect(id1).not.toBe(id2);
  });
});

describe('updateMessage', () => {
  test('updates content with string arg', async () => {
    const id = await repo.insertMessage({ threadId: 't1', role: 'assistant', content: 'old' });
    await repo.updateMessage(id, 'new content');

    const result = await repo.getThreadWithMessages('t1');
    const msg = result!.messages.find((m: any) => m.id === id);
    expect(msg!.content).toBe('new content');
  });

  test('updates content with object arg', async () => {
    const id = await repo.insertMessage({ threadId: 't1', role: 'assistant', content: 'old' });
    await repo.updateMessage(id, { content: 'updated', images: '[{"type":"image"}]' });

    const result = await repo.getThreadWithMessages('t1');
    const msg = result!.messages.find((m: any) => m.id === id);
    expect(msg!.content).toBe('updated');
  });
});

describe('getThreadWithMessages', () => {
  test('returns null for non-existent thread', async () => {
    const result = await repo.getThreadWithMessages('nonexistent');
    expect(result).toBeNull();
  });

  test('returns thread with messages in ascending order', async () => {
    await repo.insertMessage({ threadId: 't1', role: 'user', content: 'first' });
    // Small delay to ensure different timestamps
    await repo.insertMessage({ threadId: 't1', role: 'assistant', content: 'second' });

    const result = await repo.getThreadWithMessages('t1');
    expect(result).not.toBeNull();
    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0].content).toBe('first');
    expect(result!.messages[1].content).toBe('second');
  });

  test('includes tool calls with messages', async () => {
    const msgId = await repo.insertMessage({
      threadId: 't1',
      role: 'assistant',
      content: 'response',
    });

    // Insert a tool call directly
    const { db, schema } = deps;
    db.insert(schema.toolCalls)
      .values({
        id: 'tc1',
        messageId: msgId,
        name: 'Read',
        input: '{"file":"test.ts"}',
      })
      .run();

    const result = await repo.getThreadWithMessages('t1');
    const msg = result!.messages.find((m: any) => m.id === msgId);
    expect(msg!.toolCalls).toHaveLength(1);
    expect(msg!.toolCalls[0].name).toBe('Read');
  });

  test('respects messageLimit and sets hasMore', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.insertMessage({ threadId: 't1', role: 'user', content: `msg-${i}` });
    }

    const result = await repo.getThreadWithMessages('t1', 3);
    expect(result!.messages).toHaveLength(3);
    expect(result!.hasMore).toBe(true);
  });

  test('hasMore is false when all messages fit in limit', async () => {
    await repo.insertMessage({ threadId: 't1', role: 'user', content: 'only one' });

    const result = await repo.getThreadWithMessages('t1', 10);
    expect(result!.messages).toHaveLength(1);
    expect(result!.hasMore).toBe(false);
  });

  test('includes lastUserMessage', async () => {
    await repo.insertMessage({ threadId: 't1', role: 'user', content: 'user prompt' });
    await repo.insertMessage({ threadId: 't1', role: 'assistant', content: 'response' });

    const result = await repo.getThreadWithMessages('t1');
    expect(result!.lastUserMessage).toBeDefined();
    expect(result!.lastUserMessage!.content).toBe('user prompt');
  });

  test('returns ONLY the N most recent messages without server-side extension', async () => {
    // Layout (ASC): user @ 0, then 8 assistant messages @ 1..8.
    // The repo must NOT extend backwards to include the user — that's the
    // client's job (loadOlderMessages, fired on idle). Initial response stays
    // small to keep first paint fast.
    seedMessage(deps.db, { id: 'u', role: 'user', content: 'prompt', timestamp: ts(0) });
    for (let i = 1; i <= 8; i++) {
      seedMessage(deps.db, {
        id: `a${i}`,
        role: 'assistant',
        content: `reply-${i}`,
        timestamp: ts(i),
      });
    }

    const result = await repo.getThreadWithMessages('t1', 3);
    expect(result!.messages).toHaveLength(3);
    expect(result!.messages[0].id).toBe('a6');
    expect(result!.messages.at(-1)!.id).toBe('a8');
    expect(result!.hasMore).toBe(true);
    // lastUserMessage is still sent so the prompt header can render.
    expect(result!.lastUserMessage!.id).toBe('u');
  });

  test('lastUserMessage is fetched separately when no user message is in the window', async () => {
    seedMessage(deps.db, { id: 'u', role: 'user', content: 'old prompt', timestamp: ts(0) });
    for (let i = 1; i <= 5; i++) {
      seedMessage(deps.db, {
        id: `a${i}`,
        role: 'assistant',
        content: `reply-${i}`,
        timestamp: ts(i),
      });
    }

    const result = await repo.getThreadWithMessages('t1', 2);
    expect(result!.messages.every((m: any) => m.role === 'assistant')).toBe(true);
    expect(result!.hasMore).toBe(true);
    expect(result!.lastUserMessage).toBeDefined();
    expect(result!.lastUserMessage!.id).toBe('u');
    expect(result!.lastUserMessage!.content).toBe('old prompt');
  });

  test('lastUserMessage fetched out-of-window is enriched with its tool calls', async () => {
    seedMessage(deps.db, { id: 'u', role: 'user', content: 'old prompt', timestamp: ts(0) });
    seedToolCall(deps.db, { id: 'tc-u', messageId: 'u', name: 'UserTool' });
    for (let i = 1; i <= 5; i++) {
      seedMessage(deps.db, {
        id: `a${i}`,
        role: 'assistant',
        content: `reply-${i}`,
        timestamp: ts(i),
      });
    }

    const result = await repo.getThreadWithMessages('t1', 2);
    expect(result!.lastUserMessage!.id).toBe('u');
    expect(result!.lastUserMessage!.toolCalls).toHaveLength(1);
    expect(result!.lastUserMessage!.toolCalls[0].name).toBe('UserTool');
  });

  test('hasMore is false when total rows fit within the limit', async () => {
    seedMessage(deps.db, { id: 'u', role: 'user', content: 'prompt', timestamp: ts(0) });
    seedMessage(deps.db, { id: 'a1', role: 'assistant', content: 'r1', timestamp: ts(1) });

    const result = await repo.getThreadWithMessages('t1', 5);
    expect(result!.messages).toHaveLength(2);
    expect(result!.hasMore).toBe(false);
  });

  test('lastUserMessage is reused from the window when present (no extra fetch)', async () => {
    // When the window already contains the most-recent user message, the
    // implementation reuses it instead of issuing the fallback query — this
    // also exercises the code path that finds it in the loaded slice.
    seedMessage(deps.db, { id: 'u1', role: 'user', content: 'first', timestamp: ts(0) });
    seedMessage(deps.db, { id: 'a1', role: 'assistant', content: 'r1', timestamp: ts(1) });
    seedMessage(deps.db, { id: 'u2', role: 'user', content: 'second', timestamp: ts(2) });
    seedMessage(deps.db, { id: 'a2', role: 'assistant', content: 'r2', timestamp: ts(3) });

    const result = await repo.getThreadWithMessages('t1', 3);
    // Window is u2, a2 plus one more (a1) — most recent 3.
    expect(result!.messages.map((m: any) => m.id)).toEqual(['a1', 'u2', 'a2']);
    // lastUserMessage should be u2 (the most recent user, in-window).
    expect(result!.lastUserMessage!.id).toBe('u2');
    expect(result!.lastUserMessage!.content).toBe('second');
  });

  test('single tool-calls fetch covers messages and out-of-window lastUserMessage', async () => {
    // Tool calls on both an in-window assistant and the out-of-window user
    // must both be returned, even though they come from a single batched query.
    seedMessage(deps.db, { id: 'u', role: 'user', content: 'old prompt', timestamp: ts(0) });
    seedToolCall(deps.db, { id: 'tc-u', messageId: 'u', name: 'UserTool' });
    for (let i = 1; i <= 5; i++) {
      seedMessage(deps.db, {
        id: `a${i}`,
        role: 'assistant',
        content: `reply-${i}`,
        timestamp: ts(i),
      });
    }
    seedToolCall(deps.db, { id: 'tc-a5', messageId: 'a5', name: 'AsstTool' });

    const result = await repo.getThreadWithMessages('t1', 2);
    const a5 = result!.messages.find((m: any) => m.id === 'a5');
    expect(a5!.toolCalls).toHaveLength(1);
    expect(a5!.toolCalls[0].name).toBe('AsstTool');
    expect(result!.lastUserMessage!.toolCalls).toHaveLength(1);
    expect(result!.lastUserMessage!.toolCalls[0].name).toBe('UserTool');
  });

  test('parses initInfo from thread initTools', async () => {
    // Update thread to have initTools
    const { db, schema } = deps;
    db.update(schema.threads)
      .set({ initTools: '["Read","Write"]', initCwd: '/tmp', model: 'opus' })
      .where(deps.schema.threads.id.getSQL ? (undefined as any) : undefined)
      .run();

    // Re-query - simpler to just create a new thread with tools
    seedThread(deps.db, {
      id: 't2',
      // @ts-ignore
      initTools: '["Read","Write"]',
      initCwd: '/tmp',
      model: 'opus',
    });

    const result = await repo.getThreadWithMessages('t2');
    expect(result!.initInfo).toBeDefined();
    expect(result!.initInfo!.tools).toEqual(['Read', 'Write']);
    expect(result!.initInfo!.cwd).toBe('/tmp');
  });
});

describe('deleteMessagesAfter', () => {
  test('returns 0 when anchor not found', async () => {
    const deleted = await repo.deleteMessagesAfter('t1', 'missing-id');
    expect(deleted).toBe(0);
  });

  test('returns 0 when anchor is the last message', async () => {
    seedMessage(deps.db, { id: 'm1', timestamp: ts(0), role: 'user', content: 'a' });
    seedMessage(deps.db, { id: 'm2', timestamp: ts(1), role: 'assistant', content: 'b' });
    const deleted = await repo.deleteMessagesAfter('t1', 'm2');
    expect(deleted).toBe(0);
    const result = await repo.getThreadWithMessages('t1');
    expect(result!.messages.map((m: any) => m.id)).toEqual(['m1', 'm2']);
  });

  test('removes every message strictly after the anchor', async () => {
    seedMessage(deps.db, { id: 'u1', timestamp: ts(0), role: 'user', content: 'first' });
    seedMessage(deps.db, { id: 'a1', timestamp: ts(1), role: 'assistant', content: 'reply' });
    seedMessage(deps.db, { id: 'u2', timestamp: ts(2), role: 'user', content: 'second' });
    seedMessage(deps.db, { id: 'a2', timestamp: ts(3), role: 'assistant', content: 'reply2' });
    seedMessage(deps.db, { id: 'u3', timestamp: ts(4), role: 'user', content: 'third' });

    const deleted = await repo.deleteMessagesAfter('t1', 'u2');

    expect(deleted).toBe(2);
    const result = await repo.getThreadWithMessages('t1');
    expect(result!.messages.map((m: any) => m.id)).toEqual(['u1', 'a1', 'u2']);
  });

  test('cascades tool call deletion', async () => {
    seedMessage(deps.db, { id: 'u1', timestamp: ts(0), role: 'user' });
    seedMessage(deps.db, { id: 'a1', timestamp: ts(1), role: 'assistant' });
    seedToolCall(deps.db, { id: 'tc-after', messageId: 'a1', name: 'Read' });

    await repo.deleteMessagesAfter('t1', 'u1');

    const { db, schema } = deps;
    const remaining = db.select().from(schema.toolCalls).all();
    expect(remaining.find((r: any) => r.id === 'tc-after')).toBeUndefined();
  });

  test('does not touch other threads', async () => {
    seedThread(deps.db, { id: 't2' });
    seedMessage(deps.db, { id: 'a-t1', threadId: 't1', timestamp: ts(0) });
    seedMessage(deps.db, { id: 'b-t1', threadId: 't1', timestamp: ts(1) });
    seedMessage(deps.db, { id: 'a-t2', threadId: 't2', timestamp: ts(2) });

    await repo.deleteMessagesAfter('t1', 'a-t1');

    const result = await repo.getThreadWithMessages('t2');
    expect(result!.messages.map((m: any) => m.id)).toEqual(['a-t2']);
  });
});

describe('getThreadMessages (pagination)', () => {
  test('returns messages with hasMore flag', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.insertMessage({ threadId: 't1', role: 'user', content: `msg-${i}` });
    }

    const result = await repo.getThreadMessages({ threadId: 't1', limit: 3 });
    expect(result.messages).toHaveLength(3);
    expect(result.hasMore).toBe(true);
  });

  test('returns all messages when under limit', async () => {
    await repo.insertMessage({ threadId: 't1', role: 'user', content: 'only one' });

    const result = await repo.getThreadMessages({ threadId: 't1', limit: 10 });
    expect(result.messages).toHaveLength(1);
    expect(result.hasMore).toBe(false);
  });
});
