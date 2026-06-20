import { describe, expect, test, vi } from 'vitest';

import { copyCommitHashToClipboard } from '@/lib/commit-hash-copy';

describe('copyCommitHashToClipboard', () => {
  test('copies the full commit hash and returns the short hash for feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await expect(
      copyCommitHashToClipboard(
        {
          hash: '1111111111111111111111111111111111111111',
          shortHash: '1111111',
        },
        writeText,
      ),
    ).resolves.toBe('1111111');

    expect(writeText).toHaveBeenCalledWith('1111111111111111111111111111111111111111');
  });
});
