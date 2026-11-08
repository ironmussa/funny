import { createLiveQueryCollection, eq } from '@tanstack/db';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createEntityStore } from '@/data/entities';
import { getThreadsData } from '@/data/threads/store';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

afterEach(() => {
  vi.restoreAllMocks();
  resetTestDataLayer();
});

/** Above TanStack DB's dev-mode threshold (1000) for index suggestions. */
const ROWS = 1500;

describe('entity collections index their id', () => {
  test('an id lookup on a large entity store does not scan the collection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = installTestDataLayer();
    const store = createEntityStore<{ id: string; branchKey: string }>(layer, 'id-index-test');
    store.upsert(Array.from({ length: ROWS }, (_, i) => ({ id: `t${i}`, branchKey: `b${i}` })));

    const query = createLiveQueryCollection((q) =>
      q.from({ k: store.collection }).where(({ k }) => eq(k.id, 't42')),
    );
    await query.preload();

    expect(query.toArray.map((row) => row.branchKey)).toEqual(['b42']);
    expect(warn.mock.calls.flat().join('\n')).not.toContain('Index suggestion');
  });

  test('the threads collection has an id index', () => {
    const layer = installTestDataLayer();
    const metadata = getThreadsData(layer).collection.getIndexMetadata();
    expect(metadata.length).toBeGreaterThan(0);
  });
});
