import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tm: {
    getThread: vi.fn(),
    getThreadWithMessages: vi.fn(),
  },
  threadManager: {
    updateThread: vi.fn(),
  },
}));

vi.mock('../../services/thread-manager.js', () => mocks.tm);

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn() },
}));

import { recoverThreadContext } from '../../services/agent-startup/recover-context.js';

describe('recoverThreadContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('rebuilds copied history for the first message in a DB-only fork', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 'fork-1',
      sessionId: null,
      contextRecoveryReason: 'forked',
      mergedAt: null,
    });
    mocks.tm.getThreadWithMessages.mockResolvedValue({
      messages: [
        { role: 'user', content: 'Implement the login page', images: null, toolCalls: [] },
        { role: 'assistant', content: 'I will implement it.', toolCalls: [] },
      ],
    });

    const result = await recoverThreadContext({
      threadId: 'fork-1',
      prompt: 'Use email magic links instead.',
      thread: {
        sessionId: null,
        contextRecoveryReason: 'forked',
        mergedAt: null,
      },
      threadManager: mocks.threadManager as any,
    });

    expect(result).toEqual({
      effectivePrompt: expect.stringContaining(
        'USER (new message):\nUse email magic links instead.',
      ),
      effectiveSessionId: undefined,
      needsRecovery: true,
    });
    expect(result.effectivePrompt).toContain('USER:\nImplement the login page');
    expect(result.effectivePrompt).toContain('ASSISTANT:\nI will implement it.');
    expect(mocks.threadManager.updateThread).toHaveBeenCalledWith('fork-1', {
      sessionId: null,
      contextRecoveryReason: null,
    });
  });
});
