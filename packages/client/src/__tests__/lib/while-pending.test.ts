import { describe, expect, test } from 'bun:test';

import { whilePending, withCleanup, withCleanupSync } from '@/lib/while-pending';

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

describe('withCleanup', () => {
  test('cleans up after the task resolves, returning its value', async () => {
    const order: string[] = [];
    const value = await withCleanup(
      async () => {
        order.push('task');
        return 'done';
      },
      () => order.push('cleanup'),
    );
    expect(value).toBe('done');
    expect(order).toEqual(['task', 'cleanup']);
  });

  test('cleans up and rethrows when the task fails', async () => {
    let cleaned = false;
    const run = withCleanup(
      async () => {
        throw new Error('boom');
      },
      () => {
        cleaned = true;
      },
    );
    await expect(run).rejects.toThrow('boom');
    expect(cleaned).toBe(true);
  });

  test('the sync variant cleans up after a throw too', () => {
    let cleaned = false;
    expect(() =>
      withCleanupSync(
        () => {
          throw new Error('boom');
        },
        () => {
          cleaned = true;
        },
      ),
    ).toThrow('boom');
    expect(cleaned).toBe(true);
  });
});
