import { useEffect, useRef, useState } from 'react';

import { useAdjustOnChange } from '@/hooks/use-resettable-state';
import { api } from '@/lib/api';

/** Most cached searches kept; the oldest is evicted first. */
const SEARCH_CACHE_LIMIT = 50;

export function useThreadContentSearch(
  search: string,
  projectFilter: string | null,
  caseSensitive: boolean,
) {
  // Content search: debounced server call to find threads matching by message content
  // Stores threadId → snippet so we can display matching text on cards
  const [contentMatches, setContentMatches] = useState<Map<string, string>>(new Map());
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Cache: key = "query|projectId|cs" → Map<threadId, snippet>
  const [searchCache, setSearchCache] = useState<Map<string, Map<string, string>>>(new Map());

  const q = search.trim();
  const cacheKey = q ? `${q}|${projectFilter || ''}|${caseSensitive ? '1' : '0'}` : '';

  // An empty or already cached search shows its matches during render
  // (react.dev "adjusting state when a prop changes"); others wait for the server.
  useAdjustOnChange([search, cacheKey], () => {
    if (!q) {
      setContentMatches(new Map());
    } else {
      const cached = searchCache.get(cacheKey);
      if (cached) setContentMatches(cached);
    }
  });

  const isCached = searchCache.has(cacheKey);
  useEffect(() => {
    // Clear previous timer
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!q || isCached) return;

    // Debounce 300ms to avoid hammering the server on every keystroke
    searchTimerRef.current = setTimeout(() => {
      const pid = projectFilter || undefined;
      api.searchThreadContent(q, pid, caseSensitive).then((res) => {
        if (res.isOk()) {
          const map = new Map<string, string>();
          const { threadIds, snippets } = res.value;
          for (const id of threadIds) {
            map.set(id, snippets[id] || '');
          }
          setSearchCache((previous) => {
            const next = new Map(previous).set(cacheKey, map);
            // Evict old entries to prevent unbounded growth
            if (next.size > SEARCH_CACHE_LIMIT) next.delete(next.keys().next().value!);
            return next;
          });
          setContentMatches(map);
        }
      });
    }, 300);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
    // `search` restarts the debounce on every keystroke, as before.
  }, [search, q, cacheKey, isCached, projectFilter, caseSensitive]);
  return contentMatches;
}
