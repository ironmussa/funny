import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { RankedFileSearchResponse, RankedFileSearchTarget } from '@/lib/api/browse';

interface UseRankedFileSearchOptions {
  enabled: boolean;
  target: RankedFileSearchTarget | null;
  query: string;
  limit: number;
  debounceMs?: number;
}

interface RankedFileSearchState {
  response: RankedFileSearchResponse | null;
  searching: boolean;
  error: string | null;
}

const DEFAULT_DEBOUNCE_MS = 120;

export function useRankedFileSearch({
  enabled,
  target,
  query,
  limit,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: UseRankedFileSearchOptions): RankedFileSearchState {
  const [state, setState] = useState<RankedFileSearchState>({
    response: null,
    searching: false,
    error: null,
  });
  const threadId = target && 'threadId' in target ? target.threadId : undefined;
  const path = target && 'path' in target ? target.path : undefined;

  useEffect(() => {
    if (!enabled || (!threadId && !path)) {
      setState({ response: null, searching: false, error: null });
      return;
    }

    const controller = new AbortController();
    let current = true;
    setState((previous) => ({ ...previous, searching: true, error: null }));

    const timer = setTimeout(async () => {
      const searchTarget: RankedFileSearchTarget = threadId ? { threadId } : { path: path! };
      const result = await api.searchFiles(searchTarget, query, limit, controller.signal);
      if (!current || controller.signal.aborted) return;

      if (result.isErr()) {
        setState({ response: null, searching: false, error: result.error.message });
        return;
      }
      setState({ response: result.value, searching: false, error: null });
    }, debounceMs);

    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, threadId, path, query, limit, debounceMs]);

  return state;
}
