import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import { errAsync, okAsync } from 'neverthrow';

const api = (() => ({
  listTestFiles: vi.fn(),
  discoverTestSpecs: vi.fn(),
  runTest: vi.fn(),
  stopTest: vi.fn(),
}))();
mock.module('@/lib/api/tests', () => ({ testsApi: api }));

const { useTestStore } = await import('@/stores/test-store');

const initial = useTestStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useTestStore.getState().reset();
});

describe('test store', () => {
  test('reset restores every field of the initial state', () => {
    useTestStore.setState({
      files: [{ path: 'a.spec.ts' } as never],
      isRunning: true,
      activeFile: 'a.spec.ts',
      hoveredActionIndex: 3,
      selectedProjects: ['chromium'],
    });
    useTestStore.getState().reset();
    const state = useTestStore.getState();
    for (const [key, value] of Object.entries(initial)) {
      if (typeof value === 'function') continue;
      expect(state[key as keyof typeof state]).toEqual(value);
    }
  });

  test('startRun clears the previous run and records the run id', async () => {
    api.runTest.mockReturnValue(okAsync({ runId: 'r1' }));
    useTestStore.setState({ outputLines: [{ line: 'x', stream: 'stdout', timestamp: 1 }] });
    await useTestStore.getState().startRun('p1', 'a.spec.ts');
    const state = useTestStore.getState();
    expect(state.outputLines).toEqual([]);
    expect(state.isRunning).toBe(true);
    expect(state.activeFile).toBe('a.spec.ts');
    expect(state.fileStatuses['a.spec.ts']).toBe('running');
    expect(state.activeRunId).toBe('r1');
  });

  test('a spec run that fails to start marks the file failed', async () => {
    api.runTest.mockReturnValue(errAsync({ type: 'INTERNAL', message: 'boom' }));
    await useTestStore.getState().startSpecRun('p1', 'a.spec.ts', 12, 'firefox');
    expect(api.runTest).toHaveBeenCalledWith('p1', 'a.spec.ts', 12, ['firefox']);
    const state = useTestStore.getState();
    expect(state.isRunning).toBe(false);
    expect(state.activeFile).toBeNull();
    expect(state.fileStatuses['a.spec.ts']).toBe('failed');
  });

  test('a network response merges only the fields it carries', () => {
    const { handleTestNetwork } = useTestStore.getState();
    handleTestNetwork({
      phase: 'request',
      entry: { id: 'n1', url: 'https://x', method: 'GET', startTime: 100 },
    } as never);
    handleTestNetwork({
      phase: 'response',
      entry: { id: 'n1', status: 200, url: '', endTime: 150 },
    } as never);
    const [entry] = useTestStore.getState().networkEntries;
    expect(entry).toMatchObject({ id: 'n1', url: 'https://x', method: 'GET', status: 200 });
    expect(entry.duration).toBe(50);
  });
});
