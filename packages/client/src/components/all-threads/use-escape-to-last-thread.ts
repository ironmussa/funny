import { useEffect } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { buildPath } from '@/lib/url';
import { useThreadStore } from '@/stores/thread-store';

/**
 * ESC with empty search: jump back to the last thread the user was viewing,
 * or fall back to the filtered project / root. When the query has text,
 * SearchBar handles ESC by clearing it first.
 */
export function useEscapeToLastThread(
  search: string,
  navigate: NavigateFunction,
  projectFilter: string | null,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (search.trim()) return;
      const threadStore = useThreadStore.getState();
      const last = threadStore.activeThread;
      e.preventDefault();
      if (last) {
        navigate(buildPath(`/projects/${last.projectId}/threads/${last.id}`));
        return;
      }
      const lastId = threadStore.selectedThreadId;
      if (lastId && projectFilter) {
        navigate(buildPath(`/projects/${projectFilter}/threads/${lastId}`));
        return;
      }
      if (projectFilter) {
        navigate(buildPath(`/projects/${projectFilter}`));
        return;
      }
      navigate(buildPath('/'));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [search, navigate, projectFilter]);
}
