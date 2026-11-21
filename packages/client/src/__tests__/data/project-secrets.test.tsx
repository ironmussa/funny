import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

import { renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';

import { deleteProjectSecret, setProjectSecret } from '@/data/project-secrets/actions';
import { useProjectSecrets } from '@/data/project-secrets/hooks';
import type { ProjectSecretSummary } from '@/lib/api/project-secrets';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const api = (() => ({
  listProjectSecrets: vi.fn(),
  setProjectSecret: vi.fn(),
  deleteProjectSecret: vi.fn(),
}))();
vi.mock('@/lib/api/project-secrets', () => ({ projectSecretsApi: api }));

const secret = (over: Partial<ProjectSecretSummary> = {}): ProjectSecretSummary => ({
  id: 's1',
  name: 'API_KEY',
  scope: 'project',
  allowInSandbox: false,
  updatedBy: 'alice',
  updatedAt: '2026-11-20T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('project secrets (project-secrets)', () => {
  test('a saved secret shows after the server accepts it, by re-reading the list', async () => {
    api.listProjectSecrets.mockReturnValue(okAsync([]));
    const { result } = renderHook(() => useProjectSecrets('p1'));
    await waitFor(() => expect(result.current).toEqual([]));

    api.setProjectSecret.mockReturnValue(okAsync(secret()));
    api.listProjectSecrets.mockReturnValue(okAsync([secret()]));
    const saved = await setProjectSecret({
      projectId: 'p1',
      scope: 'project',
      name: 'API_KEY',
      value: 'v',
      allowInSandbox: false,
    });

    expect(saved.isOk()).toBe(true);
    await waitFor(() => expect(result.current).toEqual([secret()]));
    expect(api.listProjectSecrets).toHaveBeenCalledTimes(2);
  });

  test('a refused save answers the server error and leaves the list alone', async () => {
    api.listProjectSecrets.mockReturnValue(okAsync([secret()]));
    const { result } = renderHook(() => useProjectSecrets('p1'));
    await waitFor(() => expect(result.current).toHaveLength(1));

    api.setProjectSecret.mockReturnValue(
      errAsync({ type: 'BAD_REQUEST', message: 'This name is reserved' }),
    );
    const refused = await setProjectSecret({
      projectId: 'p1',
      scope: 'project',
      name: 'NODE_OPTIONS',
      value: 'v',
      allowInSandbox: false,
    });

    expect(refused.isErr() && refused.error.message).toBe('This name is reserved');
    expect(api.listProjectSecrets).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual([secret()]);
  });

  test('a delete re-reads the list', async () => {
    api.listProjectSecrets.mockReturnValue(okAsync([secret()]));
    const { result } = renderHook(() => useProjectSecrets('p1'));
    await waitFor(() => expect(result.current).toHaveLength(1));

    api.deleteProjectSecret.mockReturnValue(okAsync({ ok: true }));
    api.listProjectSecrets.mockReturnValue(okAsync([]));
    expect((await deleteProjectSecret('p1', 's1')).isOk()).toBe(true);

    expect(api.deleteProjectSecret).toHaveBeenCalledWith('p1', 's1');
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
