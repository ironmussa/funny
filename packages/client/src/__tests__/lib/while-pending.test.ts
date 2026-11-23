import { describe, expect, test } from 'bun:test';

import { whilePending } from '@/lib/while-pending';

describe('whilePending', () => {
  test('raises the flag while the task runs and returns its value', async () => {
    const flags: boolean[] = [];
    const value = await whilePending(
      (pending) => flags.push(pending),
      async () => {
        expect(flags).toEqual([true]);
        return 42;
      },
    );
    expect(value).toBe(42);
    expect(flags).toEqual([true, false]);
  });

  test('lowers the flag and rethrows when the task fails', async () => {
    const flags: boolean[] = [];
    const run = whilePending(
      (pending) => flags.push(pending),
      async () => {
        throw new Error('boom');
      },
    );
    await expect(run).rejects.toThrow('boom');
    expect(flags).toEqual([true, false]);
  });
});
