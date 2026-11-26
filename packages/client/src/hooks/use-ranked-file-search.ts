import { useEffect, useState } from 'react';

import { useAdjustOnChange } from '@/hooks/use-resettable-state';
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
  const threadId = target && 'threadId' in target ? target.threadId : undefined;
  const path = target && 'path' in target ? target.path : undefined;
  const active = enabled && !!(threadId || path);
  const [state, setState] = useState<RankedFileSearchState>({
    response: null,
    searching: active,
    error: null,
  });

  // Each new search shows `searching` (or clears when inactive) during render
  // (react.dev "adjusting state when a prop changes"); the effect only fetches.
  useAdjustOnChange([active, threadId, path, query, limit, debounceMs], () => {
    setState((previous) =>
      active
        ? { ...previous, searching: true, error: null }
        : { response: null, searching: false, error: null },
    );
  });

  useEffect(() => {
    if (!active) return;

    const controller = new AbortController();
    let current = true;

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
  }, [active, threadId, path, query, limit, debounceMs]);

  return state;
}
