import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { SearchBar } from '@/components/ui/search-bar';
import { api } from '@/lib/api';

interface SearchResult {
  messageId: string;
  role: string;
  content: string;
  timestamp: string;
  snippet: string;
}

interface Occurrence {
  messageId: string;
  withinIdx: number;
}

interface ThreadSearchBarProps {
  threadId: string;
  open: boolean;
  onClose: () => void;
  onNavigateToMessage: (
    messageId: string,
    query: string,
    withinIdx: number,
    reportMarkCount?: (messageId: string, count: number) => void,
  ) => void;
  /** data-testid prefix for the underlying SearchBar. Default: "thread-search". */
  testIdPrefix?: string;
  /** Override container className (positioning). Default: chat-view absolute style. */
  className?: string;
}

function countOccurrences(haystack: string, needle: string, caseSensitive: boolean): number {
  if (!needle) return 0;
  const h = caseSensitive ? haystack : haystack.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  let count = 0;
  let from = 0;
  while (true) {
    const idx = h.indexOf(n, from);
    if (idx === -1) break;
    count++;
    from = idx + n.length;
  }
  return count;
}

export function ThreadSearchBar({
  threadId,
  open,
  onClose,
  onNavigateToMessage,
  testIdPrefix = 'thread-search',
  className = 'absolute right-4 top-0 z-30 gap-1.5 rounded-b-lg border border-t-0 border-border bg-popover px-2 py-1.5 shadow-md',
}: ThreadSearchBarProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [current, setCurrent] = useState<Occurrence | null>(null);
  const [loading, setLoading] = useState(false);
  // Real DOM mark count per messageId, reported back from the chat view after
  // highlighting. Source of truth for navigation — raw-content counting can
  // overcount when matches fall inside markdown link URLs, image alt text,
  // HTML entities, etc., which would leave the cycler stuck on the last mark.
  const [markCounts, setMarkCounts] = useState<Map<string, number>>(new Map());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reportMarkCount = useCallback((messageId: string, count: number) => {
    setMarkCounts((prev) => {
      if (prev.get(messageId) === count) return prev;
      const next = new Map(prev);
      next.set(messageId, count);
      return next;
    });
    // If the real count is smaller than the optimistic one, the user's
    // current within-message index may now be out of range — clamp it so
    // the displayed counter and the next/prev navigation stay aligned.
    setCurrent((prev) => {
      if (!prev || prev.messageId !== messageId) return prev;
      if (count > 0 && prev.withinIdx >= count) {
        return { messageId, withinIdx: count - 1 };
      }
      return prev;
    });
  }, []);

  // Flatten results into per-occurrence entries. Prefer the real DOM mark
  // count (once known) and fall back to a raw-content estimate for messages
  // we haven't visited yet.
  const occurrences = useMemo<Occurrence[]>(() => {
    const q = query.trim();
    if (!q || results.length === 0) return [];
    const flat: Occurrence[] = [];
    for (const r of results) {
      const known = markCounts.get(r.messageId);
      const n = known ?? countOccurrences(r.content, q, caseSensitive);
      // Skip messages with zero real marks (e.g. match was inside a link href).
      if (n <= 0) continue;
      for (let i = 0; i < n; i++) {
        flat.push({ messageId: r.messageId, withinIdx: i });
      }
    }
    return flat;
  }, [results, query, caseSensitive, markCounts]);

  const currentIndex = useMemo(() => {
    if (!current || occurrences.length === 0) return -1;
    return occurrences.findIndex(
      (o) => o.messageId === current.messageId && o.withinIdx === current.withinIdx,
    );
  }, [current, occurrences]);

  // Reset state when thread changes or bar closes
  useEffect(() => {
    if (!open) {
      setQuery('');
      setCaseSensitive(false);
      setResults([]);
      setCurrent(null);
      setMarkCounts(new Map());
      setLoading(false);
    }
  }, [open, threadId]);

  const doSearch = useCallback(
    async (q: string, cs: boolean) => {
      if (abortRef.current) abortRef.current.abort();

      if (!q.trim()) {
        setResults([]);
        setCurrent(null);
        setMarkCounts(new Map());
        setLoading(false);
        return;
      }

      setLoading(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await api.searchThreadMessages(threadId, q.trim(), 100, cs);
        if (controller.signal.aborted) return;
        if (result.isOk()) {
          const { results: items } = result.value;
          setResults(items);
          setMarkCounts(new Map());
          if (items.length > 0) {
            setCurrent({ messageId: items[0].messageId, withinIdx: 0 });
            onNavigateToMessage(items[0].messageId, q.trim(), 0, reportMarkCount);
          } else {
            setCurrent(null);
          }
        } else {
          setResults([]);
          setCurrent(null);
        }
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
          setCurrent(null);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [threadId, onNavigateToMessage, reportMarkCount],
  );

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value, caseSensitive), 300);
  };

  const handleCaseSensitiveChange = (value: boolean) => {
    setCaseSensitive(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    doSearch(query, value);
  };

  const navigatePrev = useCallback(() => {
    if (occurrences.length === 0) return;
    const baseIdx = currentIndex < 0 ? 0 : currentIndex;
    const newIdx = baseIdx <= 0 ? occurrences.length - 1 : baseIdx - 1;
    const occ = occurrences[newIdx];
    setCurrent(occ);
    onNavigateToMessage(occ.messageId, query.trim(), occ.withinIdx, reportMarkCount);
  }, [occurrences, currentIndex, query, onNavigateToMessage, reportMarkCount]);

  const navigateNext = useCallback(() => {
    if (occurrences.length === 0) return;
    const baseIdx = currentIndex < 0 ? -1 : currentIndex;
    const newIdx = baseIdx >= occurrences.length - 1 ? 0 : baseIdx + 1;
    const occ = occurrences[newIdx];
    setCurrent(occ);
    onNavigateToMessage(occ.messageId, query.trim(), occ.withinIdx, reportMarkCount);
  }, [occurrences, currentIndex, query, onNavigateToMessage, reportMarkCount]);

  if (!open) return null;

  return (
    <SearchBar
      query={query}
      onQueryChange={handleQueryChange}
      caseSensitive={caseSensitive}
      onCaseSensitiveChange={handleCaseSensitiveChange}
      currentIndex={Math.max(0, currentIndex)}
      totalMatches={occurrences.length}
      onPrev={navigatePrev}
      onNext={navigateNext}
      onClose={onClose}
      loading={loading}
      placeholder={t('thread.searchPlaceholder', 'Search in thread...')}
      showIcon={false}
      testIdPrefix={testIdPrefix}
      className={className}
    />
  );
}
