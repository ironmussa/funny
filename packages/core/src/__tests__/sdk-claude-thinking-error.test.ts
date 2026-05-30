import { describe, test, expect } from 'vitest';

import { isThinkingBlockError } from '../agents/sdk-claude.js';

describe('isThinkingBlockError', () => {
  test('matches the Anthropic 400 for an altered thinking block', () => {
    const msg =
      'API Error: 400 messages.1.content.10: `thinking` or `redacted_thinking` blocks in the ' +
      'latest assistant message cannot be modified. These blocks must remain as they were in the ' +
      'original response.';
    expect(isThinkingBlockError(msg)).toBe(true);
  });

  test('matches the redacted_thinking variant', () => {
    expect(
      isThinkingBlockError(
        'redacted_thinking blocks in the latest assistant message cannot be modified',
      ),
    ).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(isThinkingBlockError('THINKING blocks CANNOT BE MODIFIED')).toBe(true);
  });

  test('does not match unrelated provider errors', () => {
    expect(isThinkingBlockError('API Error: 529 {"type":"overloaded_error"}')).toBe(false);
    expect(isThinkingBlockError('API Error: 400 messages.0.content: invalid tool_use block')).toBe(
      false,
    );
    expect(isThinkingBlockError('rate limit exceeded, please retry in 5s')).toBe(false);
  });
});
