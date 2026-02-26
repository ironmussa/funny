import { describe, it, expect } from 'bun:test';

import { AsyncMutex } from '../infrastructure/async-mutex.js';

describe('AsyncMutex', () => {
  it('allows single acquisition', async () => {
    const mutex = new AsyncMutex();
    expect(mutex.isLocked).toBe(false);

    const release = await mutex.acquire();
    expect(mutex.isLocked).toBe(true);

    release();
    expect(mutex.isLocked).toBe(false);
  });

  it('serializes concurrent access in FIFO order', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const task = async (id: number, delayMs: number) => {
      await mutex.runExclusive(async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, delayMs));
      });
    };

    await Promise.all([task(1, 50), task(2, 10), task(3, 10)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('releases lock on exception', async () => {
    const mutex = new AsyncMutex();

    try {
      await mutex.runExclusive(async () => {
        throw new Error('boom');
      });
    } catch {
      // expected
    }

    expect(mutex.isLocked).toBe(false);
  });

  it('release is idempotent', async () => {
    const mutex = new AsyncMutex();
    const release = await mutex.acquire();
    release();
    release(); // second call should be a no-op
    expect(mutex.isLocked).toBe(false);
  });

  it('returns value from runExclusive', async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.runExclusive(async () => 42);
    expect(result).toBe(42);
  });

  it('queues multiple waiters correctly', async () => {
    const mutex = new AsyncMutex();
    const results: number[] = [];

    // Acquire and hold the lock
    const release = await mutex.acquire();

    // Queue up 3 waiters
    const p1 = mutex.runExclusive(async () => {
      results.push(1);
    });
    const p2 = mutex.runExclusive(async () => {
      results.push(2);
    });
    const p3 = mutex.runExclusive(async () => {
      results.push(3);
    });

    // Release — all waiters should run in order
    release();
    await Promise.all([p1, p2, p3]);

    expect(results).toEqual([1, 2, 3]);
    expect(mutex.isLocked).toBe(false);
  });
});
