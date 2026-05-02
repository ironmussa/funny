import { useState, useRef, useEffect, useCallback } from 'react';
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

interface ThreadSearchBarProps {
  threadId: string;
  open: boolean;
  onClose: () => void;
  onNavigateToMessage: (messageId: string, query: string) => void;
}

export function ThreadSearchBar({
  threadId,
  open,
  onClose,
  onNavigateToMessage,
}: ThreadSearchBarProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset state when thread changes or bar closes
  useEffect(() => {
    if (!open) {
      setQuery('');
      setCaseSensitive(false);
      setResults([]);
      setCurrentIndex(0);
      setLoading(false);
    }
  }, [open, threadId]);

  const doSearch = useCallback(
    async (q: string, cs: boolean) => {
      if (abortRef.current) abortRef.current.abort();

      if (!q.trim()) {
        setResults([]);
        setCurrentIndex(0);
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
          setCurrentIndex(items.length > 0 ? 0 : -1);
          if (items.length > 0) {
            onNavigateToMessage(items[0].messageId, q.trim());
          }
        } else {
          setResults([]);
          setCurrentIndex(-1);
        }
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
          setCurrentIndex(-1);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [threadId, onNavigateToMessage],
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
    if (results.length === 0) return;
    const newIdx = currentIndex <= 0 ? results.length - 1 : currentIndex - 1;
    setCurrentIndex(newIdx);
    onNavigateToMessage(results[newIdx].messageId, query.trim());
  }, [results, currentIndex, query, onNavigateToMessage]);

  const navigateNext = useCallback(() => {
    if (results.length === 0) return;
    const newIdx = currentIndex >= results.length - 1 ? 0 : currentIndex + 1;
    setCurrentIndex(newIdx);
    onNavigateToMessage(results[newIdx].messageId, query.trim());
  }, [results, currentIndex, query, onNavigateToMessage]);

  if (!open) return null;

  return (
    <SearchBar
      query={query}
      onQueryChange={handleQueryChange}
      caseSensitive={caseSensitive}
      onCaseSensitiveChange={handleCaseSensitiveChange}
      currentIndex={Math.max(0, currentIndex)}
      totalMatches={results.length}
      onPrev={navigatePrev}
      onNext={navigateNext}
      onClose={onClose}
      loading={loading}
      placeholder={t('thread.searchPlaceholder', 'Search in thread...')}
      showIcon={false}
      testIdPrefix="thread-search"
      className="absolute right-4 top-0 z-30 gap-1.5 rounded-b-lg border border-t-0 border-border bg-popover px-2 py-1.5 shadow-md"
    />
  );
}
