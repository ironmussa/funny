import { describe, expect, test } from 'bun:test';

import { createThreadRenderItems } from '../thread-render-items';

describe('native thread render items', () => {
  test('promotes every tool call to its own virtual-list row', () => {
    const toolCallIds = Array.from({ length: 47 }, (_, index) => `tool-${index}`);
    const items = createThreadRenderItems(['message-1'], { 'message-1': toolCallIds });

    expect(items).toHaveLength(48);
    expect(items[0]).toEqual({
      id: 'message-1',
      key: 'message:message-1',
      kind: 'message',
    });
    expect(items.at(-1)).toEqual({
      id: 'tool-46',
      key: 'tool-call:tool-46',
      kind: 'tool-call',
    });
  });

  test('preserves message and tool-call ordering', () => {
    expect(createThreadRenderItems(['m1', 'm2'], { m1: ['t1', 't2'], m2: ['t3'] })).toEqual([
      { id: 'm1', key: 'message:m1', kind: 'message' },
      { id: 't1', key: 'tool-call:t1', kind: 'tool-call' },
      { id: 't2', key: 'tool-call:t2', kind: 'tool-call' },
      { id: 'm2', key: 'message:m2', kind: 'message' },
      { id: 't3', key: 'tool-call:t3', kind: 'tool-call' },
    ]);
  });
});
