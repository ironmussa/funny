import { beforeEach, describe, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({ getPRForBranch: vi.fn() }));
vi.mock('@funny/core/git', () => core);

import {
  resetPRInfoCacheForTests,
  getCachedPR,
  getPRInfoCached,
  invalidatePRInfo,
  schedulePRLookup,
} from '../../services/pr-info-cache.js';

const PR = { prNumber: 7, prUrl: 'https://github.com/o/r/pull/7', prState: 'OPEN' };

describe('pr-info-cache', () => {
  beforeEach(() => {
    resetPRInfoCacheForTests();
    core.getPRForBranch.mockReset();
  });

  test('repeated status refreshes reuse one gh lookup', async () => {
    core.getPRForBranch.mockResolvedValue(PR);

    expect(await getPRInfoCached('/repo', 'feat')).toEqual(PR);
    expect(await getPRInfoCached('/repo', 'feat')).toEqual(PR);
    expect(core.getPRForBranch).toHaveBeenCalledTimes(1);
  });

  test('concurrent callers share the in-flight lookup', async () => {
    let resolve!: (v: unknown) => void;
    core.getPRForBranch.mockReturnValue(new Promise((r) => (resolve = r)));

    const a = getPRInfoCached('/repo', 'feat');
    const b = getPRInfoCached('/repo', 'feat');
    const onUpdate = vi.fn();
    schedulePRLookup({ projectPath: '/repo', branch: 'feat', onUpdate });
    resolve(null);

    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(core.getPRForBranch).toHaveBeenCalledTimes(1);
    expect(getCachedPR('/repo', 'feat')).toBeNull(); // "no PR" is cached too
  });

  test('a failed lookup returns null and is retried next time', async () => {
    core.getPRForBranch.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValue(PR);

    expect(await getPRInfoCached('/repo', 'feat')).toBeNull();
    expect(getCachedPR('/repo', 'feat')).toBeUndefined();
    expect(await getPRInfoCached('/repo', 'feat')).toEqual(PR);
  });

  test('invalidatePRInfo drops the branch so a newly created PR shows at once', async () => {
    core.getPRForBranch.mockResolvedValueOnce(null).mockResolvedValue(PR);

    expect(await getPRInfoCached('/repo', 'feat')).toBeNull();
    invalidatePRInfo('feat');
    expect(await getPRInfoCached('/repo', 'feat')).toEqual(PR);
    expect(core.getPRForBranch).toHaveBeenCalledTimes(2);
  });

  test('entries expire after the TTL', async () => {
    vi.useFakeTimers();
    try {
      core.getPRForBranch.mockResolvedValue(PR);
      await getPRInfoCached('/repo', 'feat');
      vi.advanceTimersByTime(60_001);
      expect(getCachedPR('/repo', 'feat')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
