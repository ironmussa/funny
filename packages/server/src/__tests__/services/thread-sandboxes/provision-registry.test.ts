import { describe, expect, test } from 'bun:test';

import {
  cancelAllProvisions,
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

  test('shutdown cancels every preparation and waits for their cleanup', async () => {
    const cleaned: string[] = [];
    const prepare = (id: string) =>
      withProvisionTracking(
        id,
        (signal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => {
              // The cleanup (destroying the machine) takes a moment.
              setTimeout(() => {
                cleaned.push(id);
                resolve();
              }, 5);
            }),
          ),
      );
    const runs = [prepare('a'), prepare('b')];
    expect(await cancelAllProvisions(1_000)).toBe(2);
    expect(cleaned.sort()).toEqual(['a', 'b']);
    await Promise.all(runs);
    expect(await cancelAllProvisions(1_000)).toBe(0);
  });

  test('shutdown does not wait past its grace period', async () => {
    const stuck = withProvisionTracking('stuck', () => new Promise<void>(() => {}));
    void stuck;
    const startedAt = Date.now();
    expect(await cancelAllProvisions(20)).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
