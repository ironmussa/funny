import { describe, expect, test } from 'vitest';

import { makeLongThread } from '@/test-fixtures/long-thread-fixture';

describe('makeLongThread', () => {
  test('defaults to 500 messages with consistent counts', () => {
    const fx = makeLongThread();
    expect(fx.messages).toHaveLength(500);
    expect(fx.counts.messages).toBe(500);
    expect(fx.counts.assistant + fx.counts.user).toBe(500);
    // Assistant markdown corpus mirrors the assistant message count.
    expect(fx.markdownCorpus).toHaveLength(fx.counts.assistant);
  });

  test('is deterministic for a given seed and varies across seeds', () => {
    const a = makeLongThread({ messageCount: 60, seed: 7 });
    const b = makeLongThread({ messageCount: 60, seed: 7 });
    const c = makeLongThread({ messageCount: 60, seed: 8 });
    expect(JSON.stringify(a.messages)).toEqual(JSON.stringify(b.messages));
    expect(JSON.stringify(a.messages)).not.toEqual(JSON.stringify(c.messages));
  });

  test('alternates user/assistant with strictly increasing, parseable timestamps', () => {
    const fx = makeLongThread({ messageCount: 20 });
    let prev = -Infinity;
    fx.messages.forEach((m, i) => {
      expect(m.role).toBe(i % 2 === 0 ? 'user' : 'assistant');
      const t = Date.parse(m.timestamp);
      expect(Number.isNaN(t)).toBe(false);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    });
  });

  test('toolCallRatio bounds tool-call presence', () => {
    const none = makeLongThread({ messageCount: 100, toolCallRatio: 0 });
    expect(none.counts.toolCalls).toBe(0);
    expect(none.messages.every((m) => m.toolCalls.length === 0)).toBe(true);

    const all = makeLongThread({ messageCount: 100, toolCallRatio: 1 });
    const assistants = all.messages.filter((m) => m.role === 'assistant');
    expect(assistants.every((m) => m.toolCalls.length >= 1)).toBe(true);
    // Only assistant messages carry tool calls.
    expect(
      all.messages.filter((m) => m.role === 'user').every((m) => m.toolCalls.length === 0),
    ).toBe(true);
  });

  test('tool call ids are unique and reference their owning message', () => {
    const fx = makeLongThread({ messageCount: 200, seed: 3, toolCallRatio: 1 });
    const ids = new Set<string>();
    for (const m of fx.messages) {
      for (const tc of m.toolCalls) {
        expect(ids.has(tc.id)).toBe(false);
        ids.add(tc.id);
        expect(tc.messageId).toBe(m.id);
        expect(() => JSON.parse(tc.input)).not.toThrow();
      }
    }
    expect(ids.size).toBe(fx.counts.toolCalls);
  });
});
