import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

const { getThreadWithMessages, getThreadMessages } = (() => ({
  getThreadWithMessages: vi.fn(),
  getThreadMessages: vi.fn(),
}))();
mock.module('../../services/thread-manager.js', () => ({
  getThreadWithMessages,
  getThreadMessages,
}));

import { buildThreadContext } from '../../services/thread-context-builder.js';

describe('buildThreadContext', () => {
  beforeEach(() => {
    getThreadWithMessages.mockReset();
    getThreadMessages.mockReset();
  });

  test('returns null for a missing or empty thread', async () => {
    getThreadWithMessages.mockResolvedValueOnce(null).mockResolvedValueOnce({ messages: [] });
    expect(await buildThreadContext('missing')).toBeNull();
    expect(await buildThreadContext('empty')).toBeNull();
  });

  test('preserves user images, assistant text and abbreviated tool inputs and outputs', async () => {
    getThreadWithMessages.mockResolvedValue({
      messages: [
        { role: 'user', content: 'Inspect this', images: [{ url: 'image.png' }] },
        {
          role: 'assistant',
          content: 'Inspecting',
          toolCalls: [
            { name: 'Read', input: '{"path":"file.ts"}', output: 'x'.repeat(201) },
            { name: 'Shell', input: 'y'.repeat(201) },
            { name: 'Write', input: JSON.stringify({ content: 'z'.repeat(201) }) },
          ],
        },
      ],
    });
    const context = await buildThreadContext('thread');
    expect(context).toContain('USER:\nInspect this\n[User provided 1 image(s)]');
    expect(context).toContain('ASSISTANT:\nInspecting\n\nTool calls made:');
    expect(context).toContain('- Read\n  Input: {\n  "path": "file.ts"\n}');
    expect(context).toContain(`  Output: ${'x'.repeat(200)}...`);
    expect(context).toContain(`- Shell\n  Input: ${'y'.repeat(200)}...`);
    const prettyInput = JSON.stringify({ content: 'z'.repeat(201) }, null, 2);
    expect(context).toContain(`- Write\n  Input: ${prettyInput.slice(0, 200)}...`);
    expect(context).toContain('=== END CONVERSATION HISTORY ===');
  });

  test('retains the latest forty messages and explains omissions', async () => {
    getThreadWithMessages.mockResolvedValue({
      messages: Array.from({ length: 41 }, (_, index) => ({
        role: 'user',
        content: `message-${index}`,
      })),
    });
    const context = await buildThreadContext('thread');
    expect(context).toContain('Showing last 40 of 41 messages');
    expect(context).not.toContain('USER:\nmessage-0\n');
    expect(context).toContain('USER:\nmessage-40\n');
  });

  test('fetches only the recent window and reports the thread total', async () => {
    getThreadWithMessages.mockResolvedValue({
      total: 500,
      messages: Array.from({ length: 40 }, (_, index) => ({
        role: 'user',
        content: `message-${460 + index}`,
      })),
    });
    const context = await buildThreadContext('thread');
    expect(getThreadWithMessages).toHaveBeenCalledWith('thread', 40);
    expect(context).toContain('Showing last 40 of 500 messages');
    expect(context).toContain('USER:\nmessage-499\n');
  });

  // Regression: an ACP agent records one message per tool call, and every
  // runner restart adds an auto-resume `continue`. After two restarts the
  // user's request was outside the window, and the agent resumed with no task.
  test('pins the user request that fell out of the window behind tool calls and auto-resumes', async () => {
    const window = [
      ...Array.from({ length: 39 }, (_, index) => ({
        role: 'assistant',
        content: '',
        timestamp: `2026-11-26T08:1${index % 10}:00.000Z`,
        toolCalls: [{ name: 'Edit', input: `{"path":"file-${index}.ts"}` }],
      })),
      { role: 'user', content: 'continue', author: 'funny:auto-resume' },
    ];
    getThreadWithMessages.mockResolvedValue({ total: 300, messages: window });
    getThreadMessages
      .mockResolvedValueOnce({
        hasMore: true,
        messages: [
          { role: 'user', content: 'continue', author: 'funny:auto-resume', timestamp: 't2' },
          { role: 'assistant', content: '', timestamp: 't3' },
        ],
      })
      .mockResolvedValueOnce({
        hasMore: true,
        messages: [
          { role: 'user', content: 'Show the Antigravity limits', timestamp: 't0' },
          { role: 'assistant', content: 'Looking', timestamp: 't1' },
        ],
      });

    const context = await buildThreadContext('thread');

    expect(getThreadMessages).toHaveBeenCalledTimes(2);
    expect(getThreadMessages.mock.calls[1][0]).toMatchObject({ cursor: 't2', direction: 'before' });
    const task = context!.indexOf('=== CURRENT TASK');
    expect(task).toBeGreaterThan(-1);
    expect(context!.indexOf('USER:\nShow the Antigravity limits')).toBeGreaterThan(task);
    expect(task).toBeLessThan(context!.indexOf('=== CONVERSATION HISTORY ==='));
  });

  test('does not look further back when the window still holds a user request', async () => {
    getThreadWithMessages.mockResolvedValue({
      total: 300,
      messages: [
        { role: 'user', content: 'Fix the chip', timestamp: 't0' },
        { role: 'user', content: 'continue', author: 'funny:auto-resume', timestamp: 't1' },
      ],
    });
    const context = await buildThreadContext('thread');
    expect(getThreadMessages).not.toHaveBeenCalled();
    expect(context).not.toContain('=== CURRENT TASK');
  });
});
