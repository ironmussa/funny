import { describe, expect, test } from 'bun:test';

import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryRun } from '@/lib/api/factory';
import { groupFactoryRuns } from '@/lib/factory-run-labels';

describe('groupFactoryRuns (the factory view)', () => {
  test('groups runs by what the member sees, the ended ones last', () => {
    const run = (id: string, state: FactoryRun['state'], queueOrder: number | null = null) =>
      buildFactoryRun({ id, state, queueOrder });
    const groups = groupFactoryRuns([
      run('parked', 'waiting_human'),
      run('ci', 'waiting_ci'),
      run('admitted', 'queued'),
      run('second', 'requested', 2),
      run('first', 'requested', 1),
      run('broken', 'failed'),
      run('done', 'merged'),
      run('cancelled', 'stopped'),
    ]);
    const ids = (key: keyof typeof groups) => groups[key].map((r) => r.id);
    expect(ids('waiting')).toEqual(['parked']);
    expect(ids('active')).toEqual(['ci', 'admitted']);
    // The queue follows its own order, not the list's.
    expect(ids('queue')).toEqual(['first', 'second']);
    expect(ids('failed')).toEqual(['broken']);
    expect(ids('ended')).toEqual(['done', 'cancelled']);
  });
});
