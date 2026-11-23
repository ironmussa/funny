import { useEffect } from 'react';

import { useStableCallback } from '@/hooks/use-stable-callback';

/**
 * Loads `path`'s diff when `path` changes and the cache does not hold it yet.
 * Fires on the path only: the cache and the loader change on every load.
 */
export function useLoadDiffWhenMissing(
  path: string | null,
  diffCache: { has: (path: string) => boolean },
  load: (path: string) => void,
): void {
  const loadIfMissing = useStableCallback((p: string) => {
    if (!diffCache.has(p)) load(p);
  });
  useEffect(() => {
    if (path) loadIfMissing(path);
  }, [path, loadIfMissing]);
}
