import { describe, expect, test } from 'vitest';

import { buildPromptMilestones, type TimelineMessage } from '@/lib/prompt-timeline-milestones';

const msg = (m: Partial<TimelineMessage> & { id: string }): TimelineMessage =>
  ({ role: 'user', content: '', timestamp: `2026-01-01T00:00:0${m.id.length}Z`, ...m }) as any;

describe('buildPromptMilestones', () => {
  test('returns no milestones without messages', () => {
    expect(buildPromptMilestones([], 'completed')).toEqual([]);
  });

  test('numbers milestones sequentially and keeps first-seen todo timestamps', () => {
    const messages = [
      msg({ id: 'u', content: 'Go', timestamp: 't0' }),
      msg({
        id: 'a1',
        role: 'assistant',
        timestamp: 't1',
        toolCalls: [
          {
            id: 'tw1',
            name: 'TodoWrite',
            input: JSON.stringify({ todos: [{ content: 'A', status: 'pending' }] }),
          } as any,
        ],
      }),
      msg({
        id: 'a2',
        role: 'assistant',
        timestamp: 't2',
        toolCalls: [
          {
            id: 'tw2',
            name: 'TodoWrite',
            input: JSON.stringify({
              todos: [
                { content: 'A', status: 'completed' },
                { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
              ],
            }),
          } as any,
          {
            id: 'q',
            name: 'AskUserQuestion',
            input: JSON.stringify({ questions: [{ header: 'no question text' }] }),
          } as any,
        ],
      }),
    ];

    expect(buildPromptMilestones(messages, 'running')).toEqual([
      { id: 'timeline-start', content: 'Start', timestamp: 't0', type: 'start', index: 0 },
      { id: 'u', content: 'Go', timestamp: 't0', type: 'prompt', index: 1 },
      {
        id: 'todo-tw1-0',
        content: '1/2 · A',
        timestamp: 't1',
        type: 'todo',
        toolCallId: 'tw1',
        completed: true,
        inProgress: false,
        index: 2,
      },
      {
        id: 'todo-tw2-1',
        content: '2/2 · Doing B',
        timestamp: 't2',
        type: 'todo',
        toolCallId: 'tw2',
        completed: false,
        inProgress: true,
        index: 3,
      },
      {
        id: 'tc-q',
        content: 'Question',
        timestamp: 't2',
        type: 'question',
        toolCallId: 'q',
        index: 4,
      },
    ]);
  });

  test('adds an end marker only for finished threads', () => {
    const messages = [
      msg({ id: 'u', content: 'Go', timestamp: 't0' }),
      msg({ id: 'v', timestamp: 't9' }),
    ];
    expect(buildPromptMilestones(messages, 'idle').map((m) => m.type)).toEqual(['start', 'prompt']);
    expect(buildPromptMilestones(messages, 'failed').at(-1)).toEqual({
      id: 'timeline-end',
      content: 'Failed',
      timestamp: 't9',
      type: 'end',
      index: 2,
    });
  });
});
