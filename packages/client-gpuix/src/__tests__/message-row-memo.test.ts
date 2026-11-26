import { describe, expect, test } from 'bun:test';

import { areMessageRowsEqual } from '../app';
import { buildMessage } from './helpers/fixtures';

const message = buildMessage({ id: 'm1', threadId: 't1', role: 'assistant', content: 'hello' });
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
