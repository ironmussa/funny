import { describe, test, expect } from 'bun:test';

import {
  createConcurrencyLimiter,
  createPermitPool,
  retryAsync,
  runAsync,
  sleep,
  waitFor,
} from '../async';

describe('Effect async boundaries', () => {
  test('preserves original errors and does not start cancelled work', async () => {
    const error = new Error('domain');
    await expect(runAsync(() => Promise.reject(error))).rejects.toBe(error);
    const controller = new AbortController();
    controller.abort(error);
    let called = false;
    await expect(
      runAsync(
        async () => {
          called = true;
        },
        { signal: controller.signal },
      ),
    ).rejects.toBe(error);
    expect(called).toBe(false);
  });

  test('deadline aborts the underlying operation and preserves timeout identity', async () => {
    const error = new Error('deadline');
    let aborted = false;
    await expect(
      runAsync(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
        { timeoutMs: 5, timeoutError: () => error },
      ),
    ).rejects.toBe(error);
    expect(aborted).toBe(true);
  });

  test('subscription cleanup runs once on immediate success, error, timeout and interruption', async () => {
    for (const outcome of ['success', 'error', 'timeout', 'abort']) {
      let cleaned = 0;
      const controller = new AbortController();
      const pending = waitFor<number>(
        (resolve, reject) => {
          if (outcome === 'success') resolve(42);
          if (outcome === 'error') reject(new Error('error'));
          return () => {
            cleaned++;
          };
        },
        { signal: controller.signal, timeoutMs: 5 },
      );
      if (outcome === 'abort') controller.abort();
      if (outcome === 'success') expect(await pending).toBe(42);
      else await expect(pending).rejects.toBeDefined();
      expect(cleaned).toBe(1);
    }
  });

  test('backoff interrupts promptly', async () => {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  }, 1000);

  test('limits concurrency and releases permits after failure', async () => {
    const limit = createConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        limit(async () => {
          peak = Math.max(peak, ++active);
          try {
            await sleep(1);
            if (index === 1) throw new Error('failed');
            return index;
          } finally {
            active--;
          }
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(7);
    expect(await limit(async () => 42)).toBe(42);
  });

  test('expired and cancelled permit waiters do not consume permits', async () => {
    const pool = createPermitPool(1);
    const release = await pool.acquire();
    await expect(pool.acquire({ timeoutMs: 5 })).rejects.toBeDefined();
    const controller = new AbortController();
    const cancelled = pool.acquire({ signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toBeDefined();
    release();
    release();
    const next = await pool.acquire({ timeoutMs: 100 });
    next();
  });
});

test('agent stream preserves order and finalizes on early exit', async () => {
  const { consumeAsync } = await import('../async');
  let finalized = 0;
  const seen: number[] = [];
  async function* events() {
    try {
      yield 1;
      yield 2;
      yield 3;
    } finally {
      finalized++;
    }
  }
  await consumeAsync(events(), async (value) => {
    seen.push(value);
    return value < 2;
  });
  expect(seen).toEqual([1, 2]);
  expect(finalized).toBe(1);
});

test('agent stream cancellation interrupts a pending read and closes the iterator', async () => {
  const { consumeAsync } = await import('../async');
  const controller = new AbortController();
  let finalized = 0;
  const started = Promise.withResolvers<void>();
  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          started.resolve();
          return new Promise(() => {});
        },
        return: async () => {
          finalized++;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const running = consumeAsync(source, () => {}, { signal: controller.signal });
  await started.promise;
  controller.abort();
  await expect(running).rejects.toBeDefined();
  expect(finalized).toBe(1);
}, 1000);

test('delayed tasks cancel without executing and expose task failures', async () => {
  const { scheduleTask } = await import('../async');
  let called = false;
  const task = scheduleTask(() => {
    called = true;
  }, 60_000);
  task.cancel();
  await task.done;
  expect(called).toBe(false);
  const error = new Error('task failed');
  await expect(
    scheduleTask(() => {
      throw error;
    }, 1).done,
  ).rejects.toBe(error);
});

describe('retryAsync', () => {
  test('retryAsync retries with the computed delays and returns the success', async () => {
    const delays: number[] = [];
    const attempts: number[] = [];
    const value = await retryAsync(
      async (_signal, attempt) => {
        attempts.push(attempt);
        if (attempt < 3) throw new Error(`fail ${attempt}`);
        return 'ok';
      },
      { delayMs: (retry) => retry * 10, sleep: async (ms) => void delays.push(ms) },
    );
    expect(value).toBe('ok');
    expect(attempts).toEqual([1, 2, 3]);
    expect(delays).toEqual([10, 20]);
  });

  test('retryAsync stops after `times` and on non-retryable errors, preserving identity', async () => {
    let calls = 0;
    const last = new Error('last');
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw last;
        },
        { times: 2, delayMs: () => 0 },
      ),
    ).rejects.toBe(last);
    expect(calls).toBe(3);

    const fatal = new Error('fatal');
    let fatalCalls = 0;
    await expect(
      retryAsync(
        async () => {
          fatalCalls++;
          throw fatal;
        },
        { delayMs: () => 0, while: (error) => error !== fatal },
      ),
    ).rejects.toBe(fatal);
    expect(fatalCalls).toBe(1);
  });

  test('retryAsync backoff is interrupted by the abort signal', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    const started = Date.now();
    const pending = retryAsync(
      async () => {
        throw new Error('transient');
      },
      { delayMs: () => 10_000, signal: controller.signal },
    );
    setTimeout(() => controller.abort(reason), 10);
    await expect(pending).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
