import { describe, test, expect } from 'vitest';

import { getItemTimestamp, getItemKey, buildGroupedRenderItems } from '@/lib/render-items';
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
