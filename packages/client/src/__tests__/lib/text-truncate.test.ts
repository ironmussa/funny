import { describe, expect, it } from 'vitest';

import { middleTruncate } from '@/lib/text-truncate';

describe('middleTruncate', () => {
  it('keeps short text unchanged', () => {
    expect(middleTruncate('origin/master', 20)).toBe('origin/master');
  });

  it('caps long text with an ellipsis in the middle', () => {
    const value = middleTruncate('origin/dependabot/bun/production-dependencies-84bc67109', 20);

    expect(value).toBe('origin/dep…84bc67109');
    expect(value).toHaveLength(20);
  });

  it('keeps path tails visible when they fit inside the limit', () => {
    expect(middleTruncate('frontend-v1/src/components/Button.tsx', 32)).toBe(
      'frontend-v1/src/\u2026/Button.tsx',
    );
  });
});
