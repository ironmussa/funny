import type { CLIMessage } from '@funny/core/agents';
import { describe, expect, test, vi } from 'vitest';

import { AgentMessageHandler } from '../../services/agent-message-handler.js';
import { AgentStateTracker } from '../../services/agent-state.js';

const THREAD_ID = 'thread-streaming';

function assistant(id: string, text: string): CLIMessage {
  return {
    type: 'assistant',
    hasStableMessageId: true,
    message: { id, content: [{ type: 'text', text }] },
  } as CLIMessage;
}

describe('AgentMessageHandler — streamed assistant updates', () => {
  test.each([
    ['completed', false, true],
    ['failed', false, true],
    ['completed', true, false],
    ['stopped', false, false],
    ['interrupted', false, false],
    ['waiting', false, false],
  ])(
    'output after %s (known message: %s) resumes only new work',
    async (status, known, resumes) => {
      const threadId = `continuation-${status}-${known}`;
      const state = new AgentStateTracker();
      state.threadUserIds.set(threadId, 'user-1');
      state.resultReceived.add(threadId);
      state.completedEmitted.add(threadId);
      if (known) state.cliToDbMsgId.set(threadId, new Map([['item', 'db-1']]));
      const emitted: any[] = [];
      const thread = { userId: 'user-1', projectId: 'proj-1', status, stage: 'review' };
      const threadManager = {
        getThread: vi.fn(async () => thread),
        updateThread: vi.fn(async (_id: string, patch: object) => Object.assign(thread, patch)),
        insertMessage: vi.fn(async () => 'db-1'),
        updateMessage: vi.fn(async () => undefined),
      };
      const handler = new AgentMessageHandler(
        state,
        threadManager as any,
        {
          emit: vi.fn(),
          emitToUser: vi.fn((_user: string, event: any) => emitted.push(event)),
        } as any,
        () => undefined,
      );

      await handler.handle(threadId, assistant('item', 'Continuing work'));

      expect(thread.status).toBe(resumes ? 'running' : status);
      expect(state.resultReceived.has(threadId)).toBe(!resumes);
      expect(state.completedEmitted.has(threadId)).toBe(!resumes);
      expect(emitted.filter((event) => event.type === 'agent:status')).toHaveLength(
        resumes ? 1 : 0,
      );
      if (resumes) {
        expect(threadManager.updateThread).toHaveBeenCalledWith(threadId, {
          status: 'running',
          completedAt: null,
        });
        await handler.handle(threadId, {
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 10,
          num_turns: 1,
          total_cost_usd: 0.01,
          session_id: 'session',
        } as CLIMessage);
        expect(thread.status).toBe('completed');
        expect(emitted.filter((event) => event.type === 'agent:result')).toHaveLength(1);
      }
    },
  );

  test('updates the original message when an earlier provider item arrives after a later one', async () => {
    const state = new AgentStateTracker();
    state.threadUserIds.set(THREAD_ID, 'user-1');
    const emitted: any[] = [];
    let messageNumber = 0;
    const threadManager = {
      getThread: vi.fn(async () => ({ userId: 'user-1' })),
      insertMessage: vi.fn(async () => `db-${++messageNumber}`),
      updateMessage: vi.fn(async () => undefined),
    };
    const handler = new AgentMessageHandler(
      state,
      threadManager as any,
      {
        emit: vi.fn(),
        emitToUser: vi.fn((_userId: string, event: any) => emitted.push(event)),
      } as any,
      () => undefined,
    );

    await handler.handle(THREAD_ID, assistant('item-a', 'First draft'));
    // A distinct item becomes current before the SDK flushes item-a's final
    // update. Its new stable ID must create a new card rather than overwrite
    // the first one.
    await handler.handle(THREAD_ID, assistant('item-b', 'A later response'));
    await handler.handle(THREAD_ID, assistant('item-a', 'First response, completed'));

    expect(threadManager.insertMessage).toHaveBeenCalledTimes(2);
    expect(threadManager.updateMessage).toHaveBeenCalledWith('db-1', 'First response, completed');
    const messages = emitted.filter((event) => event.type === 'agent:message');
    expect(messages.map((event) => event.data.messageId)).toEqual(['db-1', 'db-2', 'db-1']);
  });
});
