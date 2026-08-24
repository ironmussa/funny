import { prefetchThreadData } from '@/stores/thread-machine-bridge';

export function prefetchInitialThread(pathname: string): void {
  const match = pathname.match(/\/projects\/[^/]+\/threads\/([^/]+)/);
  if (match) prefetchThreadData(match[1]);
}
