import { DYNAMIC_MODEL_PROVIDER_IDS } from '@funny/shared/provider-manifests';
import { renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useAcpModels } from '@/data/runner/hooks';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const api = vi.hoisted(() => ({ getAcpModels: vi.fn() }));
vi.mock('@/lib/api/system', () => ({ systemApi: { getAcpModels: api.getAcpModels } }));

const [first, second] = DYNAMIC_MODEL_PROVIDER_IDS;

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
  api.getAcpModels.mockImplementation((provider: string) => {
    if (provider === first) {
      return okAsync({
        ok: true,
        models: [{ modelId: 'm1', name: 'Model 1' }],
        currentModelId: 'm1',
        discoveredAt: 1,
      });
    }
    if (provider === second) {
      return okAsync({ ok: false, reason: 'sdk_missing', message: 'no CLI', discoveredAt: 1 });
    }
    return errAsync({ type: 'INTERNAL', message: 'down' });
  });
});
afterEach(() => resetTestDataLayer());

describe('useAcpModels', () => {
  test('each provider resolves on its own: ready, unavailable, or failed', async () => {
    const { result } = renderHook(() => useAcpModels());
    await waitFor(() => expect(result.current[first]?.status).toBe('ready'));
    expect(result.current[first]?.models).toEqual([{ modelId: 'm1', name: 'Model 1' }]);
    expect(result.current[second]).toMatchObject({ status: 'error', reason: 'sdk_missing' });
    for (const provider of DYNAMIC_MODEL_PROVIDER_IDS.slice(2)) {
      expect(result.current[provider]).toMatchObject({ status: 'error', reason: 'agent_error' });
    }
  });

  test('failures are cached: a remount does not re-hit the runner', async () => {
    const a = renderHook(() => useAcpModels());
    await waitFor(() => expect(a.result.current[second]?.status).toBe('error'));
    const calls = api.getAcpModels.mock.calls.length;
    a.unmount();
    const b = renderHook(() => useAcpModels());
    expect(b.result.current[second]?.status).toBe('error');
    expect(api.getAcpModels.mock.calls.length).toBe(calls);
  });
});
