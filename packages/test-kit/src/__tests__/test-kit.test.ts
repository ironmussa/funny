import { afterEach, describe, expect, test, vi } from 'bun:test';

import {
  advanceTimersByTimeAsync,
  expectRejection,
  runAllTimersAsync,
  stubEnv,
  stubGlobal,
  unstubAllEnvs,
  unstubAllGlobals,
  waitFor,
} from '../index';

afterEach(() => {
  vi.useRealTimers();
  unstubAllGlobals();
  unstubAllEnvs();
});

describe('stubGlobal', () => {
  test('replaces a global and restores it', () => {
    const fetchBefore = globalThis.fetch;
    stubGlobal('fetch', 'stub');
    stubGlobal('fetch', 'stub-2');
    expect(globalThis.fetch as unknown).toBe('stub-2');
    unstubAllGlobals();
    expect(globalThis.fetch).toBe(fetchBefore);
  });

  test('removes a global that did not exist', () => {
    stubGlobal('__testKitProbe', 1);
    expect((globalThis as Record<string, unknown>).__testKitProbe).toBe(1);
    unstubAllGlobals();
    expect('__testKitProbe' in globalThis).toBe(false);
  });
});

describe('stubEnv', () => {
  test('sets, deletes and restores variables', () => {
    const env = process.env;
    const read = (name: string): string | undefined => env[name];
    env.TEST_KIT_SET = 'before';
    delete env.TEST_KIT_UNSET;
    stubEnv('TEST_KIT_SET', undefined);
    stubEnv('TEST_KIT_UNSET', 'now');
    expect(read('TEST_KIT_SET')).toBeUndefined();
    expect(read('TEST_KIT_UNSET')).toBe('now');
    unstubAllEnvs();
    expect(read('TEST_KIT_SET')).toBe('before');
    expect(read('TEST_KIT_UNSET')).toBeUndefined();
    delete env.TEST_KIT_SET;
  });
});

describe('fake timer helpers', () => {
  test('advanceTimersByTimeAsync fires timers scheduled by resolved promises', async () => {
    vi.useFakeTimers();
    const fired: number[] = [];
    void new Promise<void>((resolve) => setTimeout(resolve, 10)).then(() => {
      setTimeout(() => fired.push(Date.now()), 10);
    });
    await advanceTimersByTimeAsync(25);
    expect(fired).toHaveLength(1);
  });

  test('runAllTimersAsync drains chained timers', async () => {
    vi.useFakeTimers();
    let count = 0;
    const tick = (): void => {
      count++;
      if (count < 5) setTimeout(() => void Promise.resolve().then(tick), 100);
    };
    tick();
    await runAllTimersAsync();
    expect(count).toBe(5);
  });
});

describe('waitFor', () => {
  test('retries until the callback passes', async () => {
    let calls = 0;
    const value = await waitFor(
      () => {
        calls++;
        if (calls < 3) throw new Error('not yet');
        return 'done';
      },
      { interval: 1 },
    );
    expect(value).toBe('done');
  });

  test('advances fake timers between attempts', async () => {
    vi.useFakeTimers();
    let ready = false;
    setTimeout(() => (ready = true), 200);
    await waitFor(() => expect(ready).toBe(true));
  });

  test('rethrows the last error after the timeout', async () => {
    await expect(
      waitFor(
        () => {
          throw new Error('never');
        },
        { timeout: 20, interval: 5 },
      ),
    ).rejects.toThrow('never');
  });
});

describe('expectRejection', () => {
  test('passes once the promise rejects with a matching error', async () => {
    vi.useFakeTimers();
    const failing = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timed out')), 100),
    );
    const assertion = expectRejection(failing, 'timed out');
    await advanceTimersByTimeAsync(100);
    await assertion;
  });

  test('fails when the error does not match', async () => {
    await expect(
      expectRejection(Promise.reject(new Error('other')), 'timed out'),
    ).rejects.toThrow();
  });

  test('fails when the promise resolves', async () => {
    await expect(expectRejection(Promise.resolve(1))).rejects.toThrow('resolved');
  });
});
