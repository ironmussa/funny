import { useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';

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
  const searchCacheRef = useRef<Map<string, Map<string, string>>>(new Map());

  useEffect(() => {
    // Clear previous timer
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    const q = search.trim();
    if (!q) {
      setContentMatches(new Map());
      return;
    }

    const cacheKey = `${q}|${projectFilter || ''}|${caseSensitive ? '1' : '0'}`;
    const cached = searchCacheRef.current.get(cacheKey);
    if (cached) {
      setContentMatches(cached);
      return;
    }

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
          searchCacheRef.current.set(cacheKey, map);
          // Evict old entries to prevent unbounded growth
          if (searchCacheRef.current.size > 50) {
            const firstKey = searchCacheRef.current.keys().next().value!;
            searchCacheRef.current.delete(firstKey);
          }
          setContentMatches(map);
        }
      });
    }, 300);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search, projectFilter, caseSensitive]);
  return contentMatches;
}
