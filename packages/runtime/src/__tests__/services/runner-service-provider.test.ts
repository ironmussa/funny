import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  remoteListProjectThreads: vi.fn(),
}));

vi.mock('../../services/remote-project-identity-client.js', () => ({
  remoteListProjectThreads: mocks.remoteListProjectThreads,
}));

import { createRunnerServiceProvider } from '../../services/runner-service-provider.js';

describe('runner service provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.remoteListProjectThreads.mockResolvedValue([
      { id: 't1', projectId: 'p1', branch: 'main' },
      { id: 't2', projectId: 'p1', branch: 'feature' },
      { id: 't3', projectId: 'p1', branch: 'other' },
    ]);
  });

  test('loads project threads through the server data channel', async () => {
    const provider = createRunnerServiceProvider();

    const result = await provider.threads.listThreads({
      projectId: 'p1',
      userId: 'u1',
      isScratch: 'exclude',
      limit: 2,
      offset: 1,
    });

    expect(mocks.remoteListProjectThreads).toHaveBeenCalledWith('p1');
    expect(result).toEqual({
      threads: [
        { id: 't2', projectId: 'p1', branch: 'feature' },
        { id: 't3', projectId: 'p1', branch: 'other' },
      ],
      total: 3,
    });
  });
});
