import { describe, expect, test } from 'bun:test';

import {
  createThrottledJSONStorage,
  discardPendingPersistWrites,
} from '@/stores/throttled-json-storage';

function fakeStorage() {
  const data = new Map<string, string>();
  const writes: string[] = [];
  return {
    data,
    writes,
    storage: {
      getItem: (name: string) => data.get(name) ?? null,
      setItem: (name: string, value: string) => {
        writes.push(value);
        data.set(name, value);
      },
      removeItem: (name: string) => {
        data.delete(name);
      },
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createThrottledJSONStorage', () => {
  test('coalesces a burst of writes into one write of the latest value', async () => {
    const fake = fakeStorage();
    const storage = createThrottledJSONStorage<{ n: number }>(() => fake.storage, { delayMs: 20 });

    for (let n = 0; n < 100; n++) storage.setItem('k', { state: { n } });
    expect(fake.writes).toHaveLength(0);

    await wait(40);
    expect(fake.writes).toEqual([JSON.stringify({ state: { n: 99 } })]);
  });

  test('skips the write when the stored value is unchanged', () => {
    const fake = fakeStorage();
    const storage = createThrottledJSONStorage<{ n: number }>(() => fake.storage);

    storage.setItem('k', { state: { n: 1 } });
    storage.flush();
    storage.setItem('k', { state: { n: 1 } });
    storage.flush();
    expect(fake.writes).toHaveLength(1);

    // Removed from outside (e.g. logout): the same value is written again.
    fake.data.delete('k');
    storage.setItem('k', { state: { n: 1 } });
    storage.flush();
    expect(fake.writes).toHaveLength(2);
  });

  test('getItem returns a pending value before it is written', () => {
    const fake = fakeStorage();
    const storage = createThrottledJSONStorage<{ n: number }>(() => fake.storage);

    storage.setItem('k', { state: { n: 7 } });
    expect(storage.getItem('k')).toEqual({ state: { n: 7 } });
    storage.flush();
  });

  test('discardPendingPersistWrites drops pending writes and refuses new ones', async () => {
    const fake = fakeStorage();
    const storage = createThrottledJSONStorage<{ n: number }>(() => fake.storage, { delayMs: 10 });

    storage.setItem('k', { state: { n: 1 } });
    discardPendingPersistWrites();
    storage.setItem('k', { state: { n: 2 } });
    await wait(30);
    storage.flush();

    expect(fake.writes).toHaveLength(0);
  });
});
