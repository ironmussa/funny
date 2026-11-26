import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { metric } from '@/lib/telemetry';

import { buildFlatRows, type SearchResponse } from './flat-row';
import { buildSearchRequest, usePersistedSearchOptions, useSearchTarget } from './search-request';

const log = createClientLogger('text-search-dialog');

const DEBOUNCE_MS = 250;
const FILE_HEADER_ROW = 28;
const MATCH_ROW = 22;

/**
 * Search state of the text search dialog: the persisted query and options, the
 * debounced request against the open thread or project, and the flattened rows.
 */
export function useTextSearch(open: boolean) {
  const { searchTarget, searchScopeKey } = useSearchTarget();
  const options = usePersistedSearchOptions();
  const { query, caseSensitive, wholeWord, regex, include, exclude } = options;

  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [activeRow, setActiveRow] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inflightSeq = useRef(0);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!searchTarget || !q) {
      setResponse(null);
      setError(null);
      setSearching(false);
      return;
    }
    const seq = ++inflightSeq.current;
    setSearching(true);
    setError(null);

    const result = await api.searchText(
      buildSearchRequest(searchTarget, q, { caseSensitive, wholeWord, regex, include, exclude }),
    );

    if (seq !== inflightSeq.current) return; // stale
    setSearching(false);
    if (result.isErr()) {
      setError(result.error.message);
      setResponse(null);
      log.warn('text search failed', { error: result.error.message });
      return;
    }
    metric('text_search.matches', result.value.totalMatches, {
      attributes: { truncated: String(result.value.truncated) },
    });
    setResponse(result.value);
    setActiveRow(0);
  }, [searchTarget, query, caseSensitive, wholeWord, regex, include, exclude]);

  useEffect(() => {
    setResponse(null);
    setError(null);
    setSearching(false);
    setCollapsed({});
    setActiveRow(0);
    inflightSeq.current += 1;
  }, [searchScopeKey]);

  // Debounced search on any input change while open.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(runSearch, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [open, runSearch]);

  const flatRows = useMemo(() => buildFlatRows(response, collapsed), [response, collapsed]);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (flatRows[i]?.kind === 'file' ? FILE_HEADER_ROW : MATCH_ROW),
    overscan: 12,
  });

  useEffect(() => {
    if (flatRows.length === 0) return;
    virtualizer.scrollToIndex(activeRow, { align: 'auto' });
  }, [activeRow, flatRows.length, virtualizer]);

  return {
    ...options,
    response,
    searching,
    error,
    setCollapsed,
    activeRow,
    setActiveRow,
    flatRows,
    scrollRef,
    virtualizer,
    hasSearchScope: !!searchTarget,
  };
}
