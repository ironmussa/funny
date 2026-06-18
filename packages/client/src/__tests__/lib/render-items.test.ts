import { describe, test, expect } from 'vitest';

import {
  buildGroupedRenderItems,
  buildRenderItemIdIndexMap,
  findNearestPrecedingUserMessageItem,
  getItemKey,
  getItemTimestamp,
} from '@/lib/render-items';
import type { RenderItem } from '@/lib/render-items';

// --- Helpers ---

function makeMessage(id: string, content: string, toolCalls: any[] = [], timestamp?: string) {
  return { id, content, toolCalls, timestamp: timestamp ?? '2024-01-01T00:00:00Z' };
}

function makeToolCall(id: string, name: string, timestamp?: string) {
  return { id, name, input: '{}', timestamp: timestamp ?? '2024-01-01T00:00:00Z' };
}

function makeThreadEvent(id: string, type: string, createdAt: string) {
  return { id, threadId: 'thread-1', type, data: '{}', createdAt };
}

// --- getItemTimestamp ---

describe('getItemTimestamp', () => {
  test('returns timestamp from message items', () => {
    const item: RenderItem = {
      type: 'message',
      msg: { id: 'm1', timestamp: '2024-01-01T00:00:00Z' },
    };
    expect(getItemTimestamp(item)).toBe('2024-01-01T00:00:00Z');
  });

  test('returns timestamp from thread-event items', () => {
    const item: RenderItem = {
      type: 'thread-event',
      event: {
        id: 'e1',
        threadId: 't1',
        type: 'git:commit',
        data: '{}',
        createdAt: '2024-01-01T00:05:00Z',
      },
    };
    expect(getItemTimestamp(item)).toBe('2024-01-01T00:05:00Z');
  });

  test('returns timestamp from toolcall items', () => {
    const item: RenderItem = {
      type: 'toolcall',
      tc: { id: 'tc1', timestamp: '2024-01-01T00:02:00Z' },
    };
    expect(getItemTimestamp(item)).toBe('2024-01-01T00:02:00Z');
  });

  test('returns timestamp from toolcall-group items', () => {
    const item: RenderItem = {
      type: 'toolcall-group',
      name: 'Read',
      calls: [
        { id: 'tc1', timestamp: '2024-01-01T00:01:00Z' },
        { id: 'tc2', timestamp: '2024-01-01T00:02:00Z' },
      ],
    };
    expect(getItemTimestamp(item)).toBe('2024-01-01T00:01:00Z');
  });

  test('returns empty string for items without timestamps', () => {
    const item: RenderItem = { type: 'message', msg: { id: 'm1' } };
    expect(getItemTimestamp(item)).toBe('');
  });
});

// --- getItemKey ---

describe('getItemKey', () => {
  test('returns id from message items', () => {
    const item: RenderItem = { type: 'message', msg: { id: 'msg-42' } };
    expect(getItemKey(item)).toBe('msg-42');
  });

  test('returns id from toolcall items', () => {
    const item: RenderItem = { type: 'toolcall', tc: { id: 'tc-7' } };
    expect(getItemKey(item)).toBe('tc-7');
  });

  test('returns first call id from toolcall-group items', () => {
    const item: RenderItem = {
      type: 'toolcall-group',
      name: 'Read',
      calls: [{ id: 'tc-first' }, { id: 'tc-second' }],
    };
    expect(getItemKey(item)).toBe('tc-first');
  });

  test('returns first item key from toolcall-run items', () => {
    const item: RenderItem = {
      type: 'toolcall-run',
      items: [{ type: 'toolcall', tc: { id: 'tc-run-1' } }],
    };
    expect(getItemKey(item)).toBe('tc-run-1');
  });

  test('returns event id from thread-event items', () => {
    const item: RenderItem = {
      type: 'thread-event',
      event: { id: 'evt-1', threadId: 't1', type: 'git:commit', data: '{}', createdAt: '' },
    };
    expect(getItemKey(item)).toBe('evt-1');
  });
});

// --- buildGroupedRenderItems ---

describe('buildGroupedRenderItems', () => {
  test('returns empty array for empty messages', () => {
    expect(buildGroupedRenderItems([])).toEqual([]);
  });

  test('creates message items for messages with content', () => {
    const messages = [makeMessage('m1', 'Hello world'), makeMessage('m2', 'Goodbye')];
    const result = buildGroupedRenderItems(messages);

    const messageItems = result.filter((r) => r.type === 'message');
    expect(messageItems).toHaveLength(2);
  });

  test('skips messages with empty content', () => {
    const messages = [makeMessage('m1', ''), makeMessage('m2', 'Has content')];
    const result = buildGroupedRenderItems(messages);

    const messageItems = result.filter((r) => r.type === 'message');
    expect(messageItems).toHaveLength(1);
  });

  test('groups consecutive same-name tool calls into toolcall-group', () => {
    const tc1 = makeToolCall('tc1', 'Read');
    const tc2 = makeToolCall('tc2', 'Read');
    const messages = [makeMessage('m1', '', [tc1, tc2])];

    const result = buildGroupedRenderItems(messages);

    const allGroups: any[] = [];
    for (const item of result) {
      if (item.type === 'toolcall-group') allGroups.push(item);
      if (item.type === 'toolcall-run') {
        for (const sub of (item as any).items) {
          if (sub.type === 'toolcall-group') allGroups.push(sub);
        }
      }
    }
    expect(allGroups).toHaveLength(1);
    expect(allGroups[0].name).toBe('Read');
    expect(allGroups[0].calls).toHaveLength(2);
  });

  test('does NOT group AskUserQuestion tool calls', () => {
    const tc1 = makeToolCall('tc1', 'AskUserQuestion');
    const tc2 = makeToolCall('tc2', 'AskUserQuestion');
    const messages = [makeMessage('m1', '', [tc1, tc2])];

    const result = buildGroupedRenderItems(messages);

    const allGroups: any[] = [];
    for (const item of result) {
      if (item.type === 'toolcall-group') allGroups.push(item);
      if (item.type === 'toolcall-run') {
        for (const sub of (item as any).items) {
          if (sub.type === 'toolcall-group') allGroups.push(sub);
        }
      }
    }
    const askGroups = allGroups.filter((g: any) => g.name === 'AskUserQuestion');
    expect(askGroups).toHaveLength(0);
  });

  test('does NOT group ExitPlanMode tool calls', () => {
    const tc1 = makeToolCall('tc1', 'ExitPlanMode');
    const tc2 = makeToolCall('tc2', 'ExitPlanMode');
    const messages = [makeMessage('m1', '', [tc1, tc2])];

    const result = buildGroupedRenderItems(messages);

    const allGroups: any[] = [];
    for (const item of result) {
      if (item.type === 'toolcall-group') allGroups.push(item);
      if (item.type === 'toolcall-run') {
        for (const sub of (item as any).items) {
          if (sub.type === 'toolcall-group') allGroups.push(sub);
        }
      }
    }
    const exitGroups = allGroups.filter((g: any) => g.name === 'ExitPlanMode');
    expect(exitGroups).toHaveLength(0);
  });

  test('wraps consecutive tool items into toolcall-run', () => {
    const tc1 = makeToolCall('tc1', 'Read');
    const tc2 = makeToolCall('tc2', 'Grep');
    const messages = [makeMessage('m1', '', [tc1, tc2])];

    const result = buildGroupedRenderItems(messages);

    const runs = result.filter((r) => r.type === 'toolcall-run');
    expect(runs).toHaveLength(1);
    expect((runs[0] as any).items).toHaveLength(2);
  });

  test('deduplicates TodoWrite - keeps only last', () => {
    const tc1 = makeToolCall('tc1', 'TodoWrite');
    const tc2 = makeToolCall('tc2', 'Read');
    const tc3 = makeToolCall('tc3', 'TodoWrite');
    const messages = [makeMessage('m1', '', [tc1, tc2, tc3])];

    const result = buildGroupedRenderItems(messages);

    const allToolCalls: any[] = [];
    for (const item of result) {
      if (item.type === 'toolcall') allToolCalls.push(item.tc);
      if (item.type === 'toolcall-group') allToolCalls.push(...(item as any).calls);
      if (item.type === 'toolcall-run') {
        for (const sub of (item as any).items) {
          if (sub.type === 'toolcall') allToolCalls.push(sub.tc);
          if (sub.type === 'toolcall-group') allToolCalls.push(...sub.calls);
        }
      }
    }

    const todoWrites = allToolCalls.filter((tc) => tc.name === 'TodoWrite');
    expect(todoWrites).toHaveLength(1);
    expect(todoWrites[0].id).toBe('tc3');
  });

  test('interleaves thread events chronologically when provided', () => {
    const messages = [
      makeMessage('m1', 'First message', [], '2024-01-01T00:01:00Z'),
      makeMessage('m2', 'Second message', [], '2024-01-01T00:03:00Z'),
    ];
    const events = [makeThreadEvent('e1', 'git:commit', '2024-01-01T00:02:00Z')];

    const result = buildGroupedRenderItems(messages, events as any);

    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('message');
    expect(result[1].type).toBe('thread-event');
    expect(result[2].type).toBe('message');
  });

  test('returns items without events when no events provided', () => {
    const messages = [makeMessage('m1', 'Hello', [], '2024-01-01T00:01:00Z')];
    const result = buildGroupedRenderItems(messages);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('message');
  });

  test('attaches plan text from Write to .plan file for ExitPlanMode', () => {
    const writeTc = {
      id: 'tc-write',
      name: 'Write',
      input: JSON.stringify({ file_path: '/project/.plan', content: '# My Plan\nStep 1\nStep 2' }),
      timestamp: '2024-01-01T00:00:00Z',
    };
    const exitTc = {
      id: 'tc-exit',
      name: 'ExitPlanMode',
      input: '{}',
      timestamp: '2024-01-01T00:00:01Z',
    };
    const messages = [makeMessage('m1', '', [writeTc]), makeMessage('m2', '', [exitTc])];

    const result = buildGroupedRenderItems(messages);

    // Find the ExitPlanMode tool call
    let exitPlanTc: any;
    for (const item of result) {
      if (item.type === 'toolcall' && item.tc.name === 'ExitPlanMode') exitPlanTc = item.tc;
      if (item.type === 'toolcall-run') {
        for (const sub of (item as any).items) {
          if (sub.type === 'toolcall' && sub.tc.name === 'ExitPlanMode') exitPlanTc = sub.tc;
        }
      }
    }
    expect(exitPlanTc).toBeDefined();
    expect(exitPlanTc._planText).toBe('# My Plan\nStep 1\nStep 2');
  });

  test('skips child tool calls with parentToolCallId from top-level', () => {
    const parentTc = {
      id: 'tc-parent',
      name: 'Task',
      input: '{"prompt":"do stuff"}',
      timestamp: '2024-01-01T00:00:00Z',
    };
    const childTc = {
      id: 'tc-child',
      name: 'Read',
      input: '{}',
      timestamp: '2024-01-01T00:00:01Z',
      parentToolCallId: 'tc-parent',
    };
    const messages = [makeMessage('m1', '', [parentTc, childTc])];

    const result = buildGroupedRenderItems(messages);

    // Collect all tool call IDs that appear at top level
    const allIds: string[] = [];
    for (const item of result) {
      if (item.type === 'toolcall') allIds.push(item.tc.id);
      if (item.type === 'toolcall-group') allIds.push(...(item as any).calls.map((c: any) => c.id));
      if (item.type === 'toolcall-run') {
        for (const sub of (item as any).items) {
          if (sub.type === 'toolcall') allIds.push(sub.tc.id);
          if (sub.type === 'toolcall-group') allIds.push(...sub.calls.map((c: any) => c.id));
        }
      }
    }
    expect(allIds).toContain('tc-parent');
    expect(allIds).not.toContain('tc-child');
  });

  test('attaches _childToolCalls to Task tool calls', () => {
    const parentTc = {
      id: 'tc-parent',
      name: 'Task',
      input: '{"prompt":"do stuff"}',
      timestamp: '2024-01-01T00:00:00Z',
    };
    const childTc1 = {
      id: 'tc-child1',
      name: 'Read',
      input: '{}',
      timestamp: '2024-01-01T00:00:01Z',
      parentToolCallId: 'tc-parent',
    };
    const childTc2 = {
      id: 'tc-child2',
      name: 'Write',
      input: '{}',
      timestamp: '2024-01-01T00:00:02Z',
      parentToolCallId: 'tc-parent',
    };
    const messages = [makeMessage('m1', '', [parentTc, childTc1, childTc2])];

    const result = buildGroupedRenderItems(messages);

    // Find the Task tool call
    let taskTc: any;
    for (const item of result) {
      if (item.type === 'toolcall' && item.tc.name === 'Task') taskTc = item.tc;
      if (item.type === 'toolcall-run') {
        for (const sub of (item as any).items) {
          if (sub.type === 'toolcall' && sub.tc.name === 'Task') taskTc = sub.tc;
        }
      }
    }
    expect(taskTc).toBeDefined();
    expect(taskTc._childToolCalls).toHaveLength(2);
    expect(taskTc._childToolCalls[0].id).toBe('tc-child1');
    expect(taskTc._childToolCalls[1].id).toBe('tc-child2');
  });

  test('does not attach _childToolCalls to non-Task tools', () => {
    const parentTc = {
      id: 'tc-parent',
      name: 'Read',
      input: '{}',
      timestamp: '2024-01-01T00:00:00Z',
    };
    const messages = [makeMessage('m1', '', [parentTc])];

    const result = buildGroupedRenderItems(messages);

    let readTc: any;
    for (const item of result) {
      if (item.type === 'toolcall' && item.tc.name === 'Read') readTc = item.tc;
      if (item.type === 'toolcall-run') {
        for (const sub of (item as any).items) {
          if (sub.type === 'toolcall' && sub.tc.name === 'Read') readTc = sub.tc;
        }
      }
    }
    expect(readTc).toBeDefined();
    expect(readTc._childToolCalls).toBeUndefined();
  });

  test('child tool calls across messages are grouped under parent', () => {
    const parentTc = {
      id: 'tc-parent',
      name: 'Task',
      input: '{}',
      timestamp: '2024-01-01T00:00:00Z',
    };
    const childTc = {
      id: 'tc-child',
      name: 'Bash',
      input: '{}',
      timestamp: '2024-01-01T00:00:01Z',
      parentToolCallId: 'tc-parent',
    };
    // Parent in first message, child in second (different assistant message)
    const messages = [makeMessage('m1', '', [parentTc]), makeMessage('m2', '', [childTc])];

    const result = buildGroupedRenderItems(messages);

    let taskTc: any;
    for (const item of result) {
      if (item.type === 'toolcall' && item.tc.name === 'Task') taskTc = item.tc;
      if (item.type === 'toolcall-run') {
        for (const sub of (item as any).items) {
          if (sub.type === 'toolcall' && sub.tc.name === 'Task') taskTc = sub.tc;
        }
      }
    }
    expect(taskTc).toBeDefined();
    expect(taskTc._childToolCalls).toHaveLength(1);
    expect(taskTc._childToolCalls[0].id).toBe('tc-child');
  });

  test('attaches plan text from Write to plan.md file for ExitPlanMode', () => {
    const writeTc = {
      id: 'tc-write',
      name: 'Write',
      input: JSON.stringify({ file_path: '/project/plan.md', content: '# Plan from MD' }),
      timestamp: '2024-01-01T00:00:00Z',
    };
    const exitTc = {
      id: 'tc-exit',
      name: 'ExitPlanMode',
      input: '{}',
      timestamp: '2024-01-01T00:00:01Z',
    };
    const messages = [makeMessage('m1', '', [writeTc, exitTc])];

    const result = buildGroupedRenderItems(messages);

    let exitPlanTc: any;
    for (const item of result) {
      if (item.type === 'toolcall' && item.tc.name === 'ExitPlanMode') exitPlanTc = item.tc;
      if (item.type === 'toolcall-run') {
        for (const sub of (item as any).items) {
          if (sub.type === 'toolcall' && sub.tc.name === 'ExitPlanMode') exitPlanTc = sub.tc;
        }
      }
    }
    expect(exitPlanTc).toBeDefined();
    expect(exitPlanTc._planText).toBe('# Plan from MD');
  });
});

describe('buildRenderItemIdIndexMap', () => {
  test('maps messages, tool calls, grouped calls, runs, and events to grouped indexes', () => {
    const items: RenderItem[] = [
      { type: 'message', msg: { id: 'm1', role: 'user' } },
      { type: 'toolcall', tc: { id: 'tc1' } },
      {
        type: 'toolcall-group',
        name: 'Read',
        calls: [{ id: 'tc2' }, { id: 'tc3' }],
      },
      {
        type: 'toolcall-run',
        items: [
          { type: 'toolcall', tc: { id: 'tc4' } },
          {
            type: 'toolcall-group',
            name: 'Grep',
            calls: [{ id: 'tc5' }, { id: 'tc6' }],
          },
        ],
      },
      {
        type: 'thread-event',
        event: { id: 'evt1', threadId: 't1', type: 'git:commit', data: '{}', createdAt: '' },
      },
      {
        type: 'workflow-event-group',
        events: [
          { id: 'wf1', threadId: 't1', type: 'git:stage', data: '{}', createdAt: '' } as any,
          { id: 'wf2', threadId: 't1', type: 'git:commit', data: '{}', createdAt: '' } as any,
        ],
      },
    ];

    const map = buildRenderItemIdIndexMap(items);

    expect(Object.fromEntries(map)).toEqual({
      m1: 0,
      tc1: 1,
      tc2: 2,
      tc3: 2,
      tc4: 3,
      tc5: 3,
      tc6: 3,
      evt1: 4,
      wf1: 5,
      wf2: 5,
    });
    expect(map.get('missing')).toBeUndefined();
  });
});

describe('findNearestPrecedingUserMessageItem', () => {
  test('returns the nearest user message before the requested index', () => {
    const items: RenderItem[] = [
      { type: 'message', msg: { id: 'u1', role: 'user' } },
      { type: 'message', msg: { id: 'a1', role: 'assistant' } },
      { type: 'toolcall', tc: { id: 'tc1' } },
      { type: 'message', msg: { id: 'u2', role: 'user' } },
      { type: 'message', msg: { id: 'a2', role: 'assistant' } },
    ];

    expect(findNearestPrecedingUserMessageItem(items, 3)?.msg.id).toBe('u1');
    expect(findNearestPrecedingUserMessageItem(items, 5)?.msg.id).toBe('u2');
    expect(findNearestPrecedingUserMessageItem(items, 0)).toBeNull();
  });
});
