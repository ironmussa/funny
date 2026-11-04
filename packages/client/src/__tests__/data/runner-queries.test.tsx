import { act, renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useRunnerProviders } from '@/data/runner/hooks';
import {
  refreshRunnerProviders,
  setActiveBuiltins,
} from '@/data/runner/queries';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const api = vi.hoisted(() => ({ getProviders: vi.fn() }));
vi.mock('@/lib/api/system', () => ({ systemApi: { getProviders: api.getProviders } }));

const advertised = {
  providers: [],
  activeBuiltins: ['claude'],
  availableProviders: ['claude'],
  hasRunner: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('runner providers', () => {
  test('spec: two components mounting together make a single request', async () => {
    api.getProviders.mockReturnValue(okAsync(advertised));
    const a = renderHook(() => useRunnerProviders());
    const b = renderHook(() => useRunnerProviders());
    await waitFor(() => expect(a.result.current.hasRunner).toBe(true));
    expect(b.result.current.activeBuiltins).toEqual(['claude']);
    expect(api.getProviders).toHaveBeenCalledTimes(1);
  });

  test('a failed load leaves availability unknown (no gating)', async () => {
    api.getProviders.mockReturnValue(errAsync({ type: 'INTERNAL', message: 'down' }));
    const { result } = renderHook(() => useRunnerProviders());
    await waitFor(() => expect(api.getProviders).toHaveBeenCalled());
    expect(result.current).toMatchObject({ activeBuiltins: null, availableProviders: null });
  });

  test('setActiveBuiltins shows the toggle at once; refresh refetches', async () => {
    api.getProviders.mockReturnValue(okAsync(advertised));
    const { result } = renderHook(() => useRunnerProviders());
    await waitFor(() => expect(result.current.hasRunner).toBe(true));

    act(() => setActiveBuiltins(['claude', 'gemini']));
    expect(result.current.activeBuiltins).toEqual(['claude', 'gemini']);

    await act(() => refreshRunnerProviders());
    expect(api.getProviders).toHaveBeenCalledTimes(2);
    expect(result.current.activeBuiltins).toEqual(['claude']);
  });
});
