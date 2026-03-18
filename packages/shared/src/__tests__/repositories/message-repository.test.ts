import { describe, test, expect, beforeEach } from 'bun:test';

import { createMessageRepository } from '../../repositories/message-repository.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

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
