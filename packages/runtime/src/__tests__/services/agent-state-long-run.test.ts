import type { CLIMessage } from '@funny/core/agents';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { AgentMessageHandler } from '../../services/agent-message-handler.js';
import { AgentStateTracker } from '../../services/agent-state.js';

const THREAD_ID = 'thread-long-run';

describe('AgentStateTracker — long-running agents', () => {
  afterEach(() => vi.useRealTimers());

  test('the stale sweep keeps the dedup state of an agent that is still sending messages', async () => {
    vi.useFakeTimers();
    const state = new AgentStateTracker();
    state.clearRunState(THREAD_ID); // run starts
    state.threadUserIds.set(THREAD_ID, 'user-1');
    state.cliToDbMsgId.set(THREAD_ID, new Map([['cli-1', 'db-1']]));

    let n = 0;
    const handler = new AgentMessageHandler(
      state,
      {
        getThread: vi.fn(async () => ({ userId: 'user-1', status: 'running' })),
        updateThread: vi.fn(async () => undefined),
        insertMessage: vi.fn(async () => `db-${++n + 1}`),
        updateMessage: vi.fn(async () => undefined),
      } as any,
      { emit: vi.fn(), emitToUser: vi.fn() } as any,
      () => undefined,
    );

    // Two hours of steady activity, longer than the 1h stale threshold.
    for (let minute = 0; minute < 120; minute += 10) {
      vi.advanceTimersByTime(10 * 60 * 1000);
      await handler.handle(THREAD_ID, {
        type: 'assistant',
        hasStableMessageId: true,
        message: { id: `cli-${minute}`, content: [{ type: 'text', text: 'working' }] },
      } as CLIMessage);
      state.sweepStale();
    }

    expect(state.cliToDbMsgId.get(THREAD_ID)?.get('cli-1')).toBe('db-1');
    expect(state.threadUserIds.get(THREAD_ID)).toBe('user-1');
  });

  test('a thread with no activity for over an hour is still swept', () => {
    vi.useFakeTimers();
    const state = new AgentStateTracker();
    state.clearRunState(THREAD_ID);
    state.cliToDbMsgId.set(THREAD_ID, new Map([['cli-1', 'db-1']]));
    vi.advanceTimersByTime(AgentStateTracker.STALE_THREAD_AGE_MS + 1);
    expect(state.sweepStale()).toBe(1);
    expect(state.cliToDbMsgId.has(THREAD_ID)).toBe(false);
  });
});
