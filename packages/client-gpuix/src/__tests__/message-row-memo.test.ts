import { describe, expect, test } from 'bun:test';

import type { Message } from '@funny/shared';

import { areMessageRowsEqual } from '../app';

const message = { id: 'm1', threadId: 't1', role: 'assistant', content: 'hello' } as Message;
describe('native message-row memoization', () => {
  test('keeps unchanged heavy rows stable across unrelated workspace updates', () => {
    expect(
      areMessageRowsEqual(
        { message, messageId: message.id, richContent: false },
        { message, messageId: message.id, richContent: false },
      ),
    ).toBe(true);
  });

  test('rerenders only when the message or render mode changes', () => {
    expect(
      areMessageRowsEqual(
        { message, messageId: message.id, richContent: false },
        {
          message: { ...message, content: 'streamed' },
          messageId: message.id,
          richContent: false,
        },
      ),
    ).toBe(false);
    expect(
      areMessageRowsEqual(
        { message, messageId: message.id, richContent: false },
        { message, messageId: message.id, richContent: true },
      ),
    ).toBe(false);
  });
});
