/**
 * Schedule triggers in the data layer (change flow-triggers): the list is read
 * once, re-read after a save or a removal, and a refused save changes nothing.
 */
import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { waitFor } from '@funny/test-kit';
import { act, renderHook } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';

import type { FactoryTrigger } from '@/lib/api/factory';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

// Not hoisted under bun test: mock first, then load the modules that read the API.
const api = {
  listTriggers: vi.fn(),
  saveTrigger: vi.fn(),
  removeTrigger: vi.fn(),
  runFlow: vi.fn(),
  listRuns: vi.fn(),
};
mock.module('@/lib/api/factory', () => ({ factoryApi: api }));

const { removeFactoryTrigger, runFactoryFlow, saveFactoryTrigger } =
  await import('@/data/factory/actions');
const { useFactoryTriggers } = await import('@/data/factory/hooks');

const nightly: FactoryTrigger = {
  id: 't1',
  name: 'Nightly audit',
  schedule: '0 3 * * *',
  flowName: 'audit',
  inputs: { scope: 'auth' },
  enabled: true,
  nextRunAt: '2026-11-24T03:00:00.000Z',
};
const draft = {
  name: 'Nightly audit',
  schedule: '0 3 * * *',
  flowName: 'audit',
  inputs: { scope: 'auth' },
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
  api.listRuns.mockReturnValue(okAsync([]));
});
afterEach(() => resetTestDataLayer());

describe('factory triggers', () => {
  test('a saved trigger shows after the list is read again', async () => {
    api.listTriggers.mockReturnValueOnce(okAsync([])).mockReturnValue(okAsync([nightly]));
    api.saveTrigger.mockReturnValue(okAsync(nightly));
    const { result } = renderHook(() => useFactoryTriggers('p1'));
    await waitFor(() => expect(result.current).toEqual([]));

    await act(async () => {
      expect((await saveFactoryTrigger('p1', draft)).isOk()).toBe(true);
    });

    expect(api.saveTrigger).toHaveBeenCalledWith({ projectId: 'p1', ...draft });
    await waitFor(() => expect(result.current).toEqual([nightly]));
  });

  test('a refused save leaves the list as it was and is not read again', async () => {
    api.listTriggers.mockReturnValue(okAsync([nightly]));
    api.saveTrigger.mockReturnValue(errAsync({ type: 'BAD_REQUEST', message: 'Invalid schedule' }));
    const { result } = renderHook(() => useFactoryTriggers('p1'));
    await waitFor(() => expect(result.current).toEqual([nightly]));

    const saved = await saveFactoryTrigger('p1', { ...draft, schedule: 'nightly' });

    expect(saved.isErr()).toBe(true);
    expect(api.listTriggers).toHaveBeenCalledTimes(1);
  });

  test('a removed trigger leaves the list after it is read again', async () => {
    api.listTriggers.mockReturnValueOnce(okAsync([nightly])).mockReturnValue(okAsync([]));
    api.removeTrigger.mockReturnValue(okAsync({ ok: true }));
    const { result } = renderHook(() => useFactoryTriggers('p1'));
    await waitFor(() => expect(result.current).toEqual([nightly]));

    await act(async () => {
      await removeFactoryTrigger('p1', 't1');
    });

    expect(api.removeTrigger).toHaveBeenCalledWith('p1', 't1');
    await waitFor(() => expect(result.current).toEqual([]));
  });

  test('starting a flow sends the project, the flow and the inputs', async () => {
    api.runFlow.mockReturnValue(okAsync({ id: 'r1' }));

    const started = await runFactoryFlow('p1', 'audit', { scope: 'auth' });

    expect(started.isOk()).toBe(true);
    expect(api.runFlow).toHaveBeenCalledWith({
      projectId: 'p1',
      flowName: 'audit',
      inputs: { scope: 'auth' },
    });
  });
});
