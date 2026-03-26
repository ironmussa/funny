import { ChevronDown, ChevronUp, X, Loader2 } from 'lucide-react';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

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
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      // Small delay so the element is rendered
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Reset state when thread changes or bar closes
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setCurrentIndex(0);
      setLoading(false);
    }
  }, [open, threadId]);

  const doSearch = useCallback(
    async (q: string) => {
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
        const result = await api.searchThreadMessages(threadId, q.trim());
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

  const handleInputChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 300);
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      navigatePrev();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      navigateNext();
    }
  };

  if (!open) return null;

  const resultLabel =
    results.length === 0
      ? t('thread.searchResults', '{{current}} of {{total}}', { current: 0, total: 0 })
      : t('thread.searchResults', '{{current}} of {{total}}', {
          current: currentIndex + 1,
          total: results.length,
        });

  return (
    <div
      className={cn(
        'absolute right-4 top-0 z-30 flex items-center gap-1.5 rounded-b-lg border border-t-0 border-border bg-popover px-2 py-1.5 shadow-md',
      )}
      data-testid="thread-search-bar"
    >
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => handleInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('thread.searchPlaceholder', 'Search in thread...')}
        className="h-7 w-56 text-sm"
        data-testid="thread-search-input"
      />

      {loading && <Loader2 className="icon-sm animate-spin text-muted-foreground" />}

      <span
        className="whitespace-nowrap text-xs text-muted-foreground"
        data-testid="thread-search-count"
      >
        {resultLabel}
      </span>

      <Button
        variant="ghost"
        size="icon-xs"
        onClick={navigatePrev}
        disabled={results.length === 0}
        data-testid="thread-search-prev"
        aria-label={t('thread.searchPrev', 'Previous result')}
      >
        <ChevronUp className="icon-sm" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={navigateNext}
        disabled={results.length === 0}
        data-testid="thread-search-next"
        aria-label={t('thread.searchNext', 'Next result')}
      >
        <ChevronDown className="icon-sm" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onClose}
        data-testid="thread-search-close"
        aria-label={t('thread.searchClose', 'Close search')}
      >
        <X className="icon-sm" />
      </Button>
    </div>
  );
}
