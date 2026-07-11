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
