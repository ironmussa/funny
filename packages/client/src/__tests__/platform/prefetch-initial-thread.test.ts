import { beforeEach, describe, expect, test, vi } from 'vitest';

import { prefetchInitialThread } from '@/platform/prefetch-initial-thread';

const { prefetch, readStorage } = vi.hoisted(() => ({
  prefetch: vi.fn(),
  readStorage: vi.fn<() => string | null>(),
}));

vi.mock('@/stores/thread-machine-bridge', () => ({ prefetchThreadData: prefetch }));
vi.mock('@/platform/client-composition', () => ({
  clientComposition: { platform: { storage: { read: readStorage } } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  readStorage.mockReturnValue(null);
});

describe('initial thread prefetch', () => {
  test('starts the restored thread at the root before route initialization', () => {
    readStorage.mockReturnValue('/acme/projects/p1/threads/t1?panel=review');

    expect(prefetchInitialThread('/')).toBe(true);
    expect(readStorage).toHaveBeenCalledWith('funny_last_route');
    expect(prefetch).toHaveBeenCalledExactlyOnceWith('t1');
  });

  test.each(['/projects/p1/threads/t2', '/acme/projects/p1/threads/t2', '/scratch/t2'])(
    'prefetches direct route %s without reading the saved route',
    (pathname) => {
      readStorage.mockReturnValue('/projects/p1/threads/t1');
      expect(prefetchInitialThread(pathname)).toBe(true);
      expect(prefetch).toHaveBeenCalledExactlyOnceWith('t2');
      expect(readStorage).not.toHaveBeenCalled();
    },
  );

  test.each(['/settings/general', '/projects/p1', '/scratch/new', '/invite/token'])(
    'does not prefetch a saved thread over explicit route %s',
    (pathname) => {
      readStorage.mockReturnValue('/projects/p1/threads/t1');
      expect(prefetchInitialThread(pathname)).toBe(false);
      expect(prefetch).not.toHaveBeenCalled();
    },
  );

  test.each([
    null,
    '',
    '/projects/p1',
    'https://example.com/projects/p1/threads/t1',
    '//example.com/projects/p1/threads/t1',
  ])('ignores missing or non-thread saved route %s', (savedRoute) => {
    readStorage.mockReturnValue(savedRoute);
    expect(prefetchInitialThread('/')).toBe(false);
    expect(prefetch).not.toHaveBeenCalled();
  });

  test('also warms restored scratch threads', () => {
    readStorage.mockReturnValue('/scratch/t1');
    expect(prefetchInitialThread('/')).toBe(true);
    expect(prefetch).toHaveBeenCalledExactlyOnceWith('t1');
  });
});
