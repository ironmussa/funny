import { errAsync, okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { createDataLayer } from '@/data/data-layer';
import { fetchProjectBranches, setProjectCurrentBranch } from '@/data/projects/branches';
import {
  fetchPRDetail,
  invalidatePR,
  isGithubRateLimited,
  prDetailQuery,
} from '@/data/pull-requests/queries';
import { replaceDataLayer, getDataLayer } from '@/data/runtime';

const mockListBranches = vi.hoisted(() => vi.fn());
const mockPRDetail = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/projects', () => ({ projectsApi: { listBranches: mockListBranches } }));
vi.mock('@/lib/api/github', () => ({
  githubApi: { githubPRDetail: mockPRDetail, githubPRThreads: vi.fn() },
}));

const listing = (currentBranch: string) => ({
  branches: ['main', currentBranch],
  remoteBranches: [],
  defaultBranch: 'main',
  currentBranch,
});

beforeEach(() => {
  vi.clearAllMocks();
  replaceDataLayer(createDataLayer({ userId: 'u1' }));
});

describe('project branches query', () => {
  test('the sidebar label and the picker share one request while fresh', async () => {
    mockListBranches.mockReturnValue(okAsync(listing('main')));

    const [a, b] = await Promise.all([fetchProjectBranches('p1'), fetchProjectBranches('p1')]);
    await fetchProjectBranches('p1');

    expect(mockListBranches).toHaveBeenCalledTimes(1);
    expect(a?.currentBranch).toBe('main');
    expect(b?.currentBranch).toBe('main');
  });

  test('force refetches a fresh listing', async () => {
    mockListBranches.mockReturnValue(okAsync(listing('main')));
    await fetchProjectBranches('p1');
    await fetchProjectBranches('p1', { force: true });

    expect(mockListBranches).toHaveBeenCalledTimes(2);
  });

  test('a checkout overrides the cached listing', async () => {
    mockListBranches.mockReturnValue(okAsync(listing('main')));
    await fetchProjectBranches('p1');

    setProjectCurrentBranch('p1', 'feat/x');

    expect((await fetchProjectBranches('p1'))?.currentBranch).toBe('feat/x');
    expect(mockListBranches).toHaveBeenCalledTimes(1);
  });
});

describe('PR detail query', () => {
  const detail = { number: 7, title: 'PR' };

  test('a rate-limit error pauses unforced fetches until a forced one succeeds', async () => {
    mockPRDetail.mockReturnValueOnce(errAsync({ type: 'INTERNAL', message: 'HTTP 403' }));
    await fetchPRDetail('p1', 7);
    expect(isGithubRateLimited()).toBe(true);

    await fetchPRDetail('p1', 7);
    expect(mockPRDetail).toHaveBeenCalledTimes(1);

    mockPRDetail.mockReturnValueOnce(okAsync(detail));
    await fetchPRDetail('p1', 7, { force: true });
    expect(isGithubRateLimited()).toBe(false);
    expect(getDataLayer().queryClient.getQueryData(prDetailQuery('p1', 7).queryKey)).toEqual(
      detail,
    );
  });

  test('invalidatePR makes the next fetch run within the freshness window', async () => {
    mockPRDetail.mockReturnValue(okAsync(detail));
    await fetchPRDetail('p1', 7);
    await fetchPRDetail('p1', 7);
    expect(mockPRDetail).toHaveBeenCalledTimes(1);

    invalidatePR('p1', 7);
    await fetchPRDetail('p1', 7);
    expect(mockPRDetail).toHaveBeenCalledTimes(2);
  });
});
