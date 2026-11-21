import { act, renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { retryFactorySettings } from '@/data/factory/actions';
import { useFactorySettings, useFactorySettingsFailed } from '@/data/factory/hooks';
import { FACTORY_SETTINGS_RETRY_MS } from '@/data/factory/queries';
import type { FactorySettings } from '@/lib/api/factory';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const api = vi.hoisted(() => ({ getSettings: vi.fn() }));
vi.mock('@/lib/api/factory', () => ({ factoryApi: { getSettings: api.getSettings } }));

const settings: FactorySettings = {
  projectId: 'p1',
  enabled: true,
  mode: 'manual',
  label: 'ready-for-agent',
  flowName: 'issue-to-merge',
  maxConcurrent: 2,
  blockedReason: null,
  updatedAt: '2026-11-21T00:00:00.000Z',
};

const down = () => errAsync({ type: 'INTERNAL', message: 'server restarting' });

function useSettingsState() {
  return { settings: useFactorySettings('p1'), failed: useFactorySettingsFailed('p1') };
}

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => {
  vi.useRealTimers();
  resetTestDataLayer();
});

describe('factory settings read', () => {
  test('a failed read is reported as failed, not as "no factory"', async () => {
    api.getSettings.mockReturnValue(down());
    const { result } = renderHook(() => useSettingsState());
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.settings).toBeUndefined();
  });

  test('regression: a failed read is retried while shown, without remounting', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getSettings.mockReturnValueOnce(down()).mockReturnValue(okAsync(settings));
    const { result } = renderHook(() => useSettingsState());
    await waitFor(() => expect(result.current.failed).toBe(true));

    await act(() => vi.advanceTimersByTimeAsync(FACTORY_SETTINGS_RETRY_MS));
    await waitFor(() => expect(result.current.settings).toEqual(settings));
    expect(result.current.failed).toBe(false);
  });

  test('a successful read does not poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getSettings.mockReturnValue(okAsync(null));
    const { result } = renderHook(() => useSettingsState());
    await waitFor(() => expect(result.current.settings).toBeNull());

    await act(() => vi.advanceTimersByTimeAsync(FACTORY_SETTINGS_RETRY_MS * 3));
    expect(api.getSettings).toHaveBeenCalledTimes(1);
  });

  test('retryFactorySettings reads them again at once', async () => {
    api.getSettings.mockReturnValueOnce(down()).mockReturnValue(okAsync(settings));
    const { result } = renderHook(() => useSettingsState());
    await waitFor(() => expect(result.current.failed).toBe(true));

    await act(() => retryFactorySettings('p1'));
    expect(result.current.settings).toEqual(settings);
  });
});
