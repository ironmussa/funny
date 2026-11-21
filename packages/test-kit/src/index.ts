/**
 * Helpers for `bun test` suites that `bun:test` does not provide. They cover
 * the vitest APIs this repo used before moving to `bun test`:
 *
 * - `stubGlobal` / `unstubAllGlobals` (vitest `vi.stubGlobal`)
 * - `stubEnv` / `unstubAllEnvs` (vitest `vi.stubEnv`)
 * - `waitFor` (vitest `vi.waitFor`)
 * - `advanceTimersByTimeAsync` / `runAllTimersAsync` /
 *   `runOnlyPendingTimersAsync` (the async fake-timer helpers)
 * - `mocked` (vitest `vi.mocked`, a type-only cast)
 * - `expectRejection` (an `expect(promise).rejects.toThrow()` you can start
 *   before the promise settles)
 *
 * Stubs are not undone automatically: call `unstubAllGlobals()` /
 * `unstubAllEnvs()` in `afterEach`, as with vitest's default config.
 */
import { expect, vi, type Mock } from 'bun:test';

const NOT_SET = Symbol('not-set');

const originalGlobals = new Map<PropertyKey, PropertyDescriptor | typeof NOT_SET>();

/** Replace `globalThis[name]` with `value` until `unstubAllGlobals()`. */
export function stubGlobal(name: PropertyKey, value: unknown): void {
  if (!originalGlobals.has(name)) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name) ?? NOT_SET);
  }
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

/** Restore every global replaced by `stubGlobal`. */
export function unstubAllGlobals(): void {
  for (const [name, original] of originalGlobals) {
    if (original === NOT_SET) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, original);
  }
  originalGlobals.clear();
}

const originalEnv = new Map<string, string | undefined>();

/** Set (or, with `undefined`, delete) `process.env[name]` until `unstubAllEnvs()`. */
export function stubEnv(name: string, value: string | undefined): void {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Restore every variable changed by `stubEnv`. */
export function unstubAllEnvs(): void {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
}

export interface WaitForOptions {
  /** Give up after this many milliseconds (default 1000). */
  timeout?: number;
  /** Retry every this many milliseconds (default 50). */
  interval?: number;
}

/**
 * Call `callback` until it returns (or resolves) without throwing, and return
 * its value; rethrow its last error after `timeout`. Works under fake timers:
 * it advances them by `interval` between attempts instead of sleeping.
 */
export async function waitFor<T>(
  callback: () => T | Promise<T>,
  options: number | WaitForOptions = {},
): Promise<T> {
  const { timeout = 1000, interval = 50 } =
    typeof options === 'number' ? { timeout: options } : options;
  const fake = vi.isFakeTimers();
  let elapsed = 0;
  const started = performance.now();
  for (;;) {
    try {
      return await callback();
    } catch (error) {
      const spent = fake ? elapsed : performance.now() - started;
      if (spent >= timeout) throw error;
    }
    if (fake) {
      await advanceTimersByTimeAsync(interval);
      elapsed += interval;
    } else {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

/** Let pending promise callbacks run (several microtask turns). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Advance fake timers by `ms`, one millisecond at a time, letting promise
 * callbacks run between steps, so timers that a resolved promise schedules
 * inside the window also fire (vitest `vi.advanceTimersByTimeAsync`).
 */
export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  await flushMicrotasks();
  for (let step = 0; step < ms; step++) {
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
  }
}

/** Run the timers pending now, then let promise callbacks run. */
export async function runOnlyPendingTimersAsync(): Promise<void> {
  await flushMicrotasks();
  vi.runOnlyPendingTimers();
  await flushMicrotasks();
}

/**
 * Run timers until none are left (at most `limit` rounds), letting promise
 * callbacks run between rounds.
 */
export async function runAllTimersAsync(limit = 10_000): Promise<void> {
  await flushMicrotasks();
  for (let round = 0; round < limit && vi.getTimerCount() > 0; round++) {
    vi.advanceTimersToNextTimer();
    await flushMicrotasks();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors vi.mocked's signature
type AnyFunction = (...args: any[]) => any;

/** Type `fn` as the mock it is (vitest `vi.mocked`); no runtime effect. */
export function mocked<T extends AnyFunction>(fn: Mock<T>): Mock<T>;
export function mocked<T extends AnyFunction>(fn: T): Mock<T>;
export function mocked<T>(value: T): {
  [K in keyof T]: T[K] extends AnyFunction ? Mock<T[K]> : T[K];
};
export function mocked(value: unknown): unknown {
  return value;
}

/**
 * Assert that `promise` rejects with an error matching `expected` (as
 * `toThrow(expected)`), without waiting for it now. bun's
 * `expect(promise).rejects` blocks until the promise settles, so a test that
 * starts the expectation and then advances fake timers, aborts or closes
 * something never gets there. Start it with this instead and await it after:
 *
 *   const failed = expectRejection(request(), 'timed out');
 *   await advanceTimersByTimeAsync(30_000);
 *   await failed;
 */
export function expectRejection(
  promise: Promise<unknown>,
  expected?: string | RegExp | Error | (new (...args: never[]) => Error),
): Promise<void> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject, but it resolved');
    },
    (error: unknown) => {
      const rethrow = (): never => {
        throw error;
      };
      if (expected === undefined) expect(rethrow).toThrow();
      else expect(rethrow).toThrow(expected as never);
    },
  );
}
