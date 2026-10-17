import { beforeEach, describe, expect, test, vi } from 'vitest';

const { getThreadWithMessages } = vi.hoisted(() => ({ getThreadWithMessages: vi.fn() }));
vi.mock('../../services/thread-manager.js', () => ({ getThreadWithMessages }));

import { buildThreadContext } from '../../services/thread-context-builder.js';

describe('buildThreadContext', () => {
  beforeEach(() => getThreadWithMessages.mockReset());

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
});
