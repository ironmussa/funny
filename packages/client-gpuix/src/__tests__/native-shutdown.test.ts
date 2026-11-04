import { describe, expect, test } from 'bun:test';

import { unmountAfterNativeShutdown } from '../native-shutdown';

describe('native shutdown', () => {
  test('unmounts and ignores the flush error from an already stopped GPUI app', () => {
    let unmounted = 0;
    expect(() =>
      unmountAfterNativeShutdown({
        unmount: () => {
          unmounted++;
          throw new Error('GPUI application is not initialized');
        },
      }),
    ).not.toThrow();
    expect(unmounted).toBe(1);
  });

  test('still surfaces unrelated unmount failures', () => {
    expect(() =>
      unmountAfterNativeShutdown({
        unmount: () => {
          throw new Error('effect cleanup failed');
        },
      }),
    ).toThrow('effect cleanup failed');
  });
});
