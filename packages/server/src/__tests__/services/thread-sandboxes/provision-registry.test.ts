import { describe, expect, test } from 'bun:test';

import {
  cancelProvision,
  withProvisionTracking,
} from '../../../services/thread-sandboxes/provision-registry.js';

describe('provision registry', () => {
  test("cancelling a thread aborts its preparation's signal", async () => {
    let seen: AbortSignal | null = null;
    let release: () => void = () => {};
    const running = withProvisionTracking('t-1', async (signal) => {
      seen = signal;
      await new Promise<void>((resolve) => (release = resolve));
      return signal.aborted;
    });
    expect(cancelProvision('t-1')).toBe(true);
    release();
    expect(await running).toBe(true);
    expect(seen!.aborted).toBe(true);
  });

  test('nothing to cancel once the preparation finished, or for another thread', async () => {
    await withProvisionTracking('t-2', async () => 'done');
    expect(cancelProvision('t-2')).toBe(false);
    expect(cancelProvision('unknown')).toBe(false);
  });
});
