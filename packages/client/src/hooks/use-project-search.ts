import type { Project } from '@funny/shared';
import { useEffect, useMemo, useState } from 'react';

import { projectsApi } from '@/lib/api/projects';

interface SearchResult {
  request: { open: boolean; search: string; orgId: string | null };
  projects: Project[];
  error: string | null;
}

export function useProjectSearch(open: boolean, search: string, orgId: string | null) {
  const request = useMemo(() => ({ open, search, orgId }), [open, search, orgId]);
  const [result, setResult] = useState<SearchResult | null>(null);

  useEffect(() => {
    if (!request.open) return;
    const controller = new AbortController();
    const timer = setTimeout(
      async () => {
        const response = await projectsApi.listProjects(
          request.orgId,
          request.search.trim(),
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResult({
          request,
          projects: response.isOk() ? response.value : [],
          error: response.isErr() ? response.error.message : null,
        });
      },
      request.search ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request]);

  const current = open && result?.request === request ? result : null;
  return {
    projects: current?.projects ?? [],
    loading: open && !current,
    error: current?.error ?? null,
  };
}
