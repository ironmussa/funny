import { useCallback } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { readThreadRow } from '@/data/threads/read';
import { buildPath } from '@/lib/url';
import { buildThreadPath } from '@/navigation/thread-paths';

/** Back button: return to the thread the view was opened from, or the filtered project. */
export function useAllThreadsBack(
  navigate: NavigateFunction,
  projectFilter: string | null,
  searchParams: URLSearchParams,
) {
  return useCallback(() => {
    const returnThreadId = searchParams.get('returnThread');
    if (returnThreadId) {
      const returnThread = readThreadRow(returnThreadId);
      if (returnThread) {
        navigate(buildThreadPath(returnThread));
        return;
      }
      if (projectFilter) {
        navigate(buildPath(`/projects/${projectFilter}/threads/${returnThreadId}`));
        return;
      }
    }
    if (projectFilter) {
      navigate(buildPath(`/projects/${projectFilter}`));
    }
  }, [navigate, projectFilter, searchParams]);
}
