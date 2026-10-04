import { parseRoute } from '@/hooks/route-parser';
import { prefetchThreadData } from '@/stores/thread-machine-bridge';

import { clientComposition } from './client-composition';

export function prefetchInitialThread(pathname: string): boolean {
  // At the root, route sync will restore the last visit after projects load.
  // Start its data now, just as we do for a direct thread URL. Navigation is
  // still owned by route sync; this is only a speculative cache warmup.
  let targetPath = pathname;
  if (pathname === '/') {
    const lastRoute = clientComposition.platform.storage.read('funny_last_route');
    if (lastRoute?.startsWith('/') && !lastRoute.startsWith('//')) {
      targetPath = lastRoute.split(/[?#]/)[0];
    }
  }
  const { threadId } = parseRoute(targetPath);
  if (!threadId) return false;
  prefetchThreadData(threadId);
  return true;
}
