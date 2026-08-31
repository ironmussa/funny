import { describe, expect, test } from 'bun:test';

import { makeRendererBenchmarkFixtures } from '@funny/client-benchmark';
import { createThreadWorkspaceStore } from '@funny/client-core';

describe('native shell fixture parity', () => {
  test('preserves inventory, ordering, checksum, and bounded 500-message history', () => {
    const fixture = makeRendererBenchmarkFixtures().a;
    const store = createThreadWorkspaceStore();
    store.getState().replaceInitialPage(fixture.threadId, {
      messages: fixture.messages as never,
      hasMore: false,
      total: fixture.counts.messages,
      windowStart: 0,
    });
    const data = store.getState().byThreadId[fixture.threadId];
    expect(fixture.checksum).toBe('1a7b1668');
    expect(fixture.featureInventory).toEqual({
      markdown: 250,
      code: 70,
      table: 57,
      toolCall: 260,
      diff: 1,
    });
    expect(data.messageIds).toEqual(fixture.messages.map((message) => message.id));
    expect(Object.keys(data.toolCallsById)).toHaveLength(fixture.counts.toolCalls);
    expect(data.messageIds).toHaveLength(500);
  });
});
