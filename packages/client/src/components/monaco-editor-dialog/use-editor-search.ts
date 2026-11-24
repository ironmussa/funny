import type { OnMount } from '@monaco-editor/react';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { useMarkdownSearch, useMonacoSearch } from './use-search-matches';

type EditorInstance = Parameters<OnMount>[0];

interface UseEditorSearchOptions {
  open: boolean;
  content: string;
  inCodeView: boolean;
  /** Ctrl+F is left to the HTML preview while it is shown. */
  htmlPreviewShown: boolean;
  editorRef: RefObject<EditorInstance | null>;
}

/**
 * Unified search state — used by both markdown preview and Monaco code view.
 */
export function useEditorSearch({
  open,
  content,
  inCodeView,
  htmlPreviewShown,
  editorRef,
}: UseEditorSearchOptions) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const query = useSearchQuery();
  const { searchOpen, setSearchOpen, debouncedQuery } = query;
  const cursor = useMatchCursor();
  const { matchCount, currentMatch, setMatchCount, setCurrentMatch } = cursor;
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);

  useFindShortcut(open && !htmlPreviewShown, setSearchOpen, searchInputRef);

  const matchState = { searchOpen, debouncedQuery, content, inCodeView, currentMatch, matchCount };
  const { previewContainerRef } = useMarkdownSearch({
    ...matchState,
    setMatchCount,
    setCurrentMatch,
  });
  const { detachEditor } = useMonacoSearch({
    ...matchState,
    regex,
    caseSensitive,
    wholeWord,
    editorRef,
    setMatchCount,
    setCurrentMatch,
  });

  return {
    previewContainerRef,
    searchInputRef,
    searchOpen,
    setSearchOpen,
    searchQuery: query.searchQuery,
    setSearchQuery: query.setSearchQuery,
    debouncedQuery,
    matchCount,
    currentMatch,
    caseSensitive,
    setCaseSensitive,
    wholeWord,
    setWholeWord,
    regex,
    setRegex,
    goToNextMatch: cursor.goToNextMatch,
    goToPrevMatch: cursor.goToPrevMatch,
    closeSearch: query.closeSearch,
    detachEditor,
  };
}

/** The search bar's open state and query, debounced for the match search. */
function useSearchQuery() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Debounce typing so the (expensive) DOM walk / findMatches runs after a short pause.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(id);
  }, [searchQuery]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
  }, []);

  return { searchOpen, setSearchOpen, searchQuery, setSearchQuery, debouncedQuery, closeSearch };
}

/** Number of matches and the focused one, with next / previous navigation. */
function useMatchCursor() {
  const [matchCount, setMatchCount] = useState(0);
  // 0-based index of the currently focused match. `-1` means no active match.
  const [currentMatch, setCurrentMatch] = useState(-1);

  const goToNextMatch = useCallback(() => {
    setCurrentMatch((prev) => stepMatch(prev, 1, matchCount));
  }, [matchCount]);

  const goToPrevMatch = useCallback(() => {
    setCurrentMatch((prev) => stepMatch(prev, -1, matchCount));
  }, [matchCount]);

  return { matchCount, setMatchCount, currentMatch, setCurrentMatch, goToNextMatch, goToPrevMatch };
}

/** Next (`1`) or previous (`-1`) match index, wrapping around; `-1` without matches. */
function stepMatch(current: number, step: 1 | -1, count: number): number {
  if (count === 0) return -1;
  return (current + step + count) % count;
}

/**
 * Ctrl+F → open the unified search bar (both code and markdown views).
 * Capture phase + preventDefault prevents Monaco's built-in find widget from opening.
 */
function useFindShortcut(
  enabled: boolean,
  setSearchOpen: (open: boolean) => void,
  searchInputRef: RefObject<HTMLInputElement | null>,
): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== 'f') return;
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [enabled, setSearchOpen, searchInputRef]);
}
