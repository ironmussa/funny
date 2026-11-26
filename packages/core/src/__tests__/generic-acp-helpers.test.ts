import { describe, expect, test } from 'bun:test';

import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';

import {
  findSelectConfigOption,
  toolResultMessage,
  toolUseMessage,
} from '../agents/generic-acp-helpers.js';

describe('findSelectConfigOption', () => {
  test('returns null when the agent advertises no options', () => {
    expect(findSelectConfigOption(undefined, 'model')).toBeNull();
    expect(findSelectConfigOption(null, 'model')).toBeNull();
    expect(findSelectConfigOption([], 'model')).toBeNull();
  });

  test('collects the value ids of a select option, flattening groups', () => {
    const configOptions: SessionConfigOption[] = [
      {
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'low',
        options: [{ value: 'low', name: 'Low' }],
      },
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'a',
        options: [
          { group: 'g1', name: 'Group', options: [{ value: 'a', name: 'A' }] },
          { value: 'b', name: 'B' },
        ],
      },
    ];

    const model = findSelectConfigOption(configOptions, 'model');
    expect(model?.configId).toBe('model');
    expect([...(model?.valueIds ?? [])].sort()).toEqual(['a', 'b']);

    const effort = findSelectConfigOption(configOptions, 'thought_level');
    expect(effort?.configId).toBe('effort');
    expect([...(effort?.valueIds ?? [])]).toEqual(['low']);
  });
});

describe('tool message builders', () => {
  test('toolUseMessage wraps one tool_use block under a fresh message id', () => {
    const first = toolUseMessage('call-1', 'Think', { content: 'hm' });
    const second = toolUseMessage('call-1', 'Think', { content: 'hm' });
    expect(first.type).toBe('assistant');
    if (first.type !== 'assistant' || second.type !== 'assistant') return;
    expect(first.message.content).toEqual([
      { type: 'tool_use', id: 'call-1', name: 'Think', input: { content: 'hm' } },
    ]);
    expect(first.message.id).not.toBe(second.message.id);
  });

  test('toolResultMessage wraps one tool_result block', () => {
    expect(toolResultMessage('call-1', 'done')).toEqual({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] },
    });
  });
});
