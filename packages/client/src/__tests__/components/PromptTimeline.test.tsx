import type { ThreadStatus } from '@funny/shared';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { PromptTimeline } from '@/components/thread/PromptTimeline';

import { renderWithProviders } from '../helpers/render';

const ts = (offsetMin: number) => new Date(Date.now() - (60 - offsetMin) * 60_000).toISOString();

function todoWrite(id: string, todos: unknown[]) {
  return { id, name: 'TodoWrite', input: JSON.stringify({ todos }) };
}

function buildMessages(): any[] {
  return [
    { id: 'm1', role: 'user', content: 'Fix the bug', timestamp: ts(0) },
    {
      id: 'm2',
      role: 'assistant',
      content: '',
      timestamp: ts(1),
      toolCalls: [
        todoWrite('tw1', [
          { content: 'A', activeForm: 'Doing A', status: 'completed' },
          { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
        ]),
        {
          id: 'q1',
          name: 'AskUserQuestion',
          input: JSON.stringify({ questions: [{ question: 'Which DB?' }] }),
        },
      ],
    },
    { id: 'm3', role: 'user', content: '   ', timestamp: ts(2) },
    {
      id: 'm4',
      role: 'assistant',
      content: '',
      timestamp: ts(3),
      toolCalls: [
        { id: 'p1', name: 'ExitPlanMode', input: JSON.stringify({ plan: 'x' }) },
        { id: 'r1', name: 'Read', input: JSON.stringify({ file_path: 'a.ts' }) },
        { id: 'q2', name: 'AskUserQuestion', input: JSON.stringify({ questions: [] }) },
        { id: 'bad', name: 'TodoWrite', input: 'not json' },
        { id: 'empty', name: 'TodoWrite', input: JSON.stringify({ todos: [] }) },
        todoWrite('tw2', [
          { content: 'A', activeForm: 'Doing A', status: 'completed' },
          { content: 'B', activeForm: 'Doing B', status: 'completed' },
          { content: 'C', activeForm: 'Doing C', status: 'in_progress' },
        ]),
      ],
    },
    { id: 'm5', role: 'user', content: 'Thanks', timestamp: ts(4) },
  ];
}

interface Rendered {
  text: string;
  completed: boolean;
  inProgress: boolean;
  args: unknown[];
}

function renderTimeline(messages: any[], threadStatus?: ThreadStatus): Rendered[] {
  const onScroll = vi.fn();
  renderWithProviders(
    <PromptTimeline messages={messages} threadStatus={threadStatus} onScrollToMessage={onScroll} />,
  );
  return screen.getAllByRole('button').map((button, i) => {
    fireEvent.click(button);
    const label = button.firstElementChild as HTMLElement;
    return {
      text: button.textContent ?? '',
      completed: label.className.includes('line-through'),
      inProgress: label.className.includes('text-blue-400'),
      args: onScroll.mock.calls[i],
    };
  });
}

describe('PromptTimeline milestones', () => {
  test('renders nothing without messages', () => {
    const { container } = renderWithProviders(<PromptTimeline messages={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('builds prompt, todo, question and plan milestones for a running thread', () => {
    expect(renderTimeline(buildMessages(), 'running')).toEqual([
      { text: 'Start', completed: false, inProgress: false, args: ['timeline-start', undefined] },
      { text: 'Fix the bug', completed: false, inProgress: false, args: ['m1'] },
      { text: '1/3 · A', completed: true, inProgress: false, args: ['todo-tw1-0', 'tw1'] },
      { text: '2/3 · B', completed: true, inProgress: false, args: ['todo-tw1-1', 'tw1'] },
      { text: 'Which DB?', completed: false, inProgress: false, args: ['tc-q1', 'q1'] },
      {
        text: 'Plan ready for review',
        completed: false,
        inProgress: false,
        args: ['tc-p1', 'p1'],
      },
      { text: '3/3 · Doing C', completed: false, inProgress: true, args: ['todo-tw2-2', 'tw2'] },
      { text: 'Thanks', completed: false, inProgress: false, args: ['m5'] },
    ]);
  });

  test.each([
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['stopped', 'Stopped'],
  ] as const)(
    'finished thread (%s) completes in-progress todos and adds an end marker',
    (status, label) => {
      const rendered = renderTimeline(buildMessages(), status);
      expect(rendered.map((r) => r.text)).toEqual([
        'Start',
        'Fix the bug',
        '1/3 · A',
        '2/3 · B',
        'Which DB?',
        'Plan ready for review',
        '3/3 · C',
        'Thanks',
        label,
      ]);
      expect(rendered[6]).toMatchObject({ completed: true, inProgress: false });
      expect(rendered[8].args).toEqual(['timeline-end', undefined]);
    },
  );

  test('labels todos without content or activeForm by step number', () => {
    const messages = [
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: ts(0),
        toolCalls: [todoWrite('t1', [{ status: 'pending' }])],
      },
    ];
    expect(renderTimeline(messages).map((r) => r.text)).toEqual(['Start', '1/1 · Task 1']);
  });

  test('emits todos first seen in earlier snapshots at the later snapshot when skipped', () => {
    // A todo that only appears in the first snapshot but not the last is dropped;
    // todos first introduced by the second snapshot are emitted there.
    const messages = [
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: ts(0),
        toolCalls: [todoWrite('t1', [{ content: 'Old', status: 'pending' }])],
      },
      {
        id: 'a2',
        role: 'assistant',
        content: '',
        timestamp: ts(1),
        toolCalls: [
          todoWrite('t2', [{ content: 'New', activeForm: 'Making new', status: 'pending' }]),
        ],
      },
    ];
    expect(renderTimeline(messages, 'idle').map((r) => [r.text, r.args])).toEqual([
      ['Start', ['timeline-start', undefined]],
      ['1/1 · New', ['todo-t2-0', 't2']],
    ]);
  });
});
