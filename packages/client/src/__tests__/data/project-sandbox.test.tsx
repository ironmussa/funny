import { act, renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearProjectSandbox, saveProjectSandbox } from '@/data/runner/actions';
import { useProjectSandbox } from '@/data/runner/hooks';
import { refreshSandboxConnections } from '@/data/runner/queries';
import { clientComposition } from '@/platform/client-composition';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const api = vi.hoisted(() => ({
  listInfraConnections: vi.fn(),
  getProjectSandbox: vi.fn(),
  saveProjectSandbox: vi.fn(),
  clearProjectSandbox: vi.fn(),
}));
vi.mock('@/lib/api/system', () => ({ systemApi: { getProviders: vi.fn() } }));
vi.mock('@/lib/api/infra', () => ({ infraApi: api }));

const connection = {
  id: 'c1',
  provider: 'instabox',
  label: 'InstaBox',
  accountLabel: null,
  createdAt: '',
  lastValidatedAt: null,
};
const settings = {
  projectId: 'p1',
  connectionId: 'c1',
  sizeId: 'default',
  enabledByDefault: true,
  updatedAt: '2026-11-08T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
  api.listInfraConnections.mockReturnValue(okAsync({ connections: [connection] }));
});
afterEach(() => resetTestDataLayer());

describe('project sandbox (project-sandboxes)', () => {
  test('reads the configuration with its connection; none means null', async () => {
    api.getProjectSandbox.mockImplementation((projectId: string) =>
      okAsync({ settings: projectId === 'p1' ? settings : null }),
    );
    const configured = renderHook(() => useProjectSandbox('p1'));
    await waitFor(() =>
      expect(configured.result.current.sandbox?.connection?.label).toBe('InstaBox'),
    );
    expect(configured.result.current.sandbox?.settings.sizeId).toBe('default');

    const none = renderHook(() => useProjectSandbox('p2'));
    await waitFor(() => expect(api.getProjectSandbox).toHaveBeenCalledWith('p2'));
    expect(none.result.current.sandbox).toBeNull();

    renderHook(() => useProjectSandbox(null));
    expect(api.getProjectSandbox).not.toHaveBeenCalledWith('');
  });

  test('save shows the server answer; a refusal restores the previous value with a toast', async () => {
    api.getProjectSandbox.mockReturnValue(okAsync({ settings }));
    const { result } = renderHook(() => useProjectSandbox('p1'));
    await waitFor(() => expect(result.current.sandbox).not.toBeNull());

    api.saveProjectSandbox.mockReturnValue(
      okAsync({ settings: { ...settings, sizeId: 'large', enabledByDefault: false } }),
    );
    await act(() =>
      saveProjectSandbox('p1', { connectionId: 'c1', sizeId: 'large', enabledByDefault: false }),
    );
    expect(result.current.sandbox?.settings).toMatchObject({
      sizeId: 'large',
      enabledByDefault: false,
    });

    const emit = vi.spyOn(clientComposition.platform.effects, 'emit');
    api.clearProjectSandbox.mockReturnValue(errAsync({ type: 'INTERNAL', message: 'down' }));
    const cleared = await act(() => clearProjectSandbox('p1'));
    expect(cleared.isErr()).toBe(true);
    expect(result.current.sandbox?.settings.sizeId).toBe('large');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'toast', level: 'error' }));
  });

  test('refreshing connections refetches the project sandboxes', async () => {
    api.getProjectSandbox.mockReturnValue(okAsync({ settings }));
    const { result } = renderHook(() => useProjectSandbox('p1'));
    await waitFor(() => expect(result.current.sandbox).not.toBeNull());

    // The connection was removed: the server dropped the project's sandbox too.
    api.getProjectSandbox.mockReturnValue(okAsync({ settings: null }));
    await act(() => refreshSandboxConnections());
    await waitFor(() => expect(result.current.sandbox).toBeNull());
  });
});
