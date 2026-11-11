import { beforeEach, describe, expect, test } from 'vitest';

import { useCheckRunsStore } from '@/stores/check-runs-store';

const run = (inputKey: string, path = `/tmp/${inputKey}.json`) => ({
  runId: inputKey,
  kind: 'test',
  path,
  inputKey,
  startedAt: 1,
});

beforeEach(() => useCheckRunsStore.setState({ byThread: {} }));

describe('check-runs store', () => {
  test('keeps the latest run per thread and input', () => {
    const { record } = useCheckRunsStore.getState();
    record('t1', run('k1', '/tmp/first.json'));
    record('t1', run('k1', '/tmp/second.json'));
    record('t2', run('k1'));
    const { byThread } = useCheckRunsStore.getState();
    expect(byThread.t1.k1.path).toBe('/tmp/second.json');
    expect(byThread.t2.k1.path).toBe('/tmp/k1.json');
  });

  test('forgets the oldest runs of a busy thread', () => {
    const { record } = useCheckRunsStore.getState();
    for (let i = 0; i < 60; i++) record('t1', run(`k${i}`));
    const runs = useCheckRunsStore.getState().byThread.t1;
    expect(Object.keys(runs)).toHaveLength(50);
    expect(runs.k0).toBeUndefined();
    expect(runs.k59).toBeDefined();
  });
});
