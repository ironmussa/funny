import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSessionMessages: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionMessages: mocks.getSessionMessages,
}));

import {
  isPromptUserMessage,
  resolveSdkUserMessageUuid,
} from '../../services/thread-service/sdk-session.js';

describe('isPromptUserMessage', () => {
  test('returns false for non-user messages', () => {
    expect(isPromptUserMessage({ type: 'assistant' } as any)).toBe(false);
  });

  test('returns true for string-content user prompts', () => {
    expect(
      isPromptUserMessage({
        type: 'user',
        message: { content: 'hello' },
      } as any),
    ).toBe(true);
  });

  test('returns false for user messages that are tool results', () => {
    expect(
      isPromptUserMessage({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }],
        },
      } as any),
    ).toBe(false);
  });
});

describe('resolveSdkUserMessageUuid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns uuid at the requested user prompt index', async () => {
    mocks.getSessionMessages.mockResolvedValue([
      { type: 'user', uuid: 'uuid-0', message: { content: 'first' } },
      { type: 'assistant', uuid: 'uuid-a1' },
      {
        type: 'user',
        uuid: 'uuid-tool',
        message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] },
      },
      { type: 'user', uuid: 'uuid-1', message: { content: 'second' } },
    ]);

    const result = await resolveSdkUserMessageUuid(
      { sessionId: 'sess-1', cwd: '/repo', userMsgIndex: 1 },
      (code) => {
        throw new Error(code);
      },
    );

    expect(result).toEqual({ uuid: 'uuid-1', promptCount: 2 });
    expect(mocks.getSessionMessages).toHaveBeenCalledWith('sess-1', { dir: '/repo' });
  });

  test('invokes onError when transcript read fails', async () => {
    mocks.getSessionMessages.mockRejectedValue(new Error('ENOENT'));

    await expect(
      resolveSdkUserMessageUuid(
        { sessionId: 'sess-1', cwd: '/repo', userMsgIndex: 0 },
        (code, detail) => {
          throw new Error(`${code}:${detail}`);
        },
      ),
    ).rejects.toThrow('transcript_read_failed:ENOENT');
  });

  test('invokes onError when user prompt index is out of range', async () => {
    mocks.getSessionMessages.mockResolvedValue([
      { type: 'user', uuid: 'uuid-0', message: { content: 'only one' } },
    ]);

    await expect(
      resolveSdkUserMessageUuid(
        { sessionId: 'sess-1', cwd: '/repo', userMsgIndex: 3 },
        (code, detail) => {
          throw new Error(`${code}:${detail}`);
        },
      ),
    ).rejects.toThrow('sdk_message_not_found:index=3');
  });
});
