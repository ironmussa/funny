import { processError } from '@funny/shared/errors';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({ lookupPRForBranch: vi.fn() }));
vi.mock('@funny/core/git', () => core);

import {
  resetPRInfoCacheForTests,
  getCachedPR,
  getPRInfoCached,
  invalidatePRInfo,
  schedulePRLookup,
} from '../../services/pr-info-cache.js';

const PR = { prNumber: 7, prUrl: 'https://github.com/o/r/pull/7', prState: 'OPEN' };

/** A lookup that resolves when `resolve` is called, like a slow `gh` call. */
function deferredLookup() {
  let resolve!: (value: typeof PR | null) => void;
  const promise = new Promise<typeof PR | null>((r) => (resolve = r));
  return { lookup: ResultAsync.fromSafePromise(promise), resolve };
}

describe('pr-info-cache', () => {
  beforeEach(() => {
    resetPRInfoCacheForTests();
    core.lookupPRForBranch.mockReset();
  });

  test('repeated status refreshes reuse one gh lookup', async () => {
    core.lookupPRForBranch.mockImplementation(() => okAsync(PR));

    expect(await getPRInfoCached('/repo', 'feat')).toEqual(PR);
    expect(await getPRInfoCached('/repo', 'feat')).toEqual(PR);
    expect(core.lookupPRForBranch).toHaveBeenCalledTimes(1);
  });

  test('concurrent callers share the in-flight lookup', async () => {
    const { lookup, resolve } = deferredLookup();
    core.lookupPRForBranch.mockReturnValue(lookup);

    const a = getPRInfoCached('/repo', 'feat');
    const b = getPRInfoCached('/repo', 'feat');
    const onUpdate = vi.fn();
    schedulePRLookup({ projectPath: '/repo', branch: 'feat', onUpdate });
    resolve(null);

    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(core.lookupPRForBranch).toHaveBeenCalledTimes(1);
    expect(getCachedPR('/repo', 'feat')).toBeNull(); // a confirmed "no PR" is cached
  });

  test('a failed gh lookup (rate limit, auth, timeout) is not cached as "no PR"', async () => {
    core.lookupPRForBranch
      .mockReturnValueOnce(errAsync(processError('gh pr list failed', 1, 'API rate limit')))
      .mockImplementation(() => okAsync(PR));

    expect(await getPRInfoCached('/repo', 'feat')).toBeNull();
    expect(getCachedPR('/repo', 'feat')).toBeUndefined();
    expect(await getPRInfoCached('/repo', 'feat')).toEqual(PR);
  });

  test('invalidatePRInfo drops the branch so a newly created PR shows at once', async () => {
    core.lookupPRForBranch.mockReturnValueOnce(okAsync(null)).mockImplementation(() => okAsync(PR));

    expect(await getPRInfoCached('/repo', 'feat')).toBeNull();
    invalidatePRInfo('feat');
    expect(await getPRInfoCached('/repo', 'feat')).toEqual(PR);
    expect(core.lookupPRForBranch).toHaveBeenCalledTimes(2);
  });

  test('a lookup in flight during invalidation cannot write its stale answer back', async () => {
    const stale = deferredLookup();
    core.lookupPRForBranch.mockReturnValueOnce(stale.lookup).mockImplementation(() => okAsync(PR));

    const before = getPRInfoCached('/repo', 'feat'); // started before the PR existed
    invalidatePRInfo('feat'); // PR created meanwhile
    expect(await getPRInfoCached('/repo', 'feat')).toEqual(PR); // fresh lookup, not the old one

    stale.resolve(null); // the old lookup finishes late
    expect(await before).toBeNull();
    expect(getCachedPR('/repo', 'feat')).toEqual(PR);
  });

  test('entries expire after the TTL', async () => {
    vi.useFakeTimers();
    try {
      core.lookupPRForBranch.mockImplementation(() => okAsync(PR));
      await getPRInfoCached('/repo', 'feat');
      vi.advanceTimersByTime(60_001);
      expect(getCachedPR('/repo', 'feat')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
