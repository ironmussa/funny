import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { searchAddonRegistry } from '@/components/terminal/xterm-utils';
import { SearchBar } from '@/components/ui/search-bar';

/** Search overlay shown over the active terminal when the user presses Ctrl+F. */
export function TerminalSearchOverlay({
  activeTabId,
  onClose,
}: {
  activeTabId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<{ resultIndex: number; resultCount: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refocus the input when Ctrl+F is pressed again while the overlay is open
  // (e.g. focus was lost to the terminal or another element).
  useEffect(() => {
    const focus = () => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    };
    window.addEventListener('terminal:search-focus', focus);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('terminal:search-focus', focus);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const decorations = useMemo(
    () => ({
      matchBorder: '#ffd900',
      activeMatchBorder: '#ff9900',
      matchOverviewRuler: '#ffd900',
      activeMatchColorOverviewRuler: '#ff9900',
    }),
    [],
  );

  useEffect(() => {
    const addon = searchAddonRegistry.get(activeTabId);
    if (!addon) return;
    const dispose = addon.onDidChangeResults((res) => setResult(res));
    return () => dispose.dispose();
  }, [activeTabId]);

  // Re-run search incrementally on query/option changes
  useEffect(() => {
    const addon = searchAddonRegistry.get(activeTabId);
    if (!addon) return;
    if (!query) {
      addon.clearDecorations();
      setResult(null);
      return;
    }
    addon.findNext(query, {
      caseSensitive,
      wholeWord,
      regex,
      decorations,
      incremental: true,
    });
  }, [query, caseSensitive, wholeWord, regex, activeTabId, decorations]);

  const findNext = useCallback(() => {
    const addon = searchAddonRegistry.get(activeTabId);
    if (!addon || !query) return;
    addon.findNext(query, { caseSensitive, wholeWord, regex, decorations });
  }, [activeTabId, query, caseSensitive, wholeWord, regex, decorations]);

  const findPrev = useCallback(() => {
    const addon = searchAddonRegistry.get(activeTabId);
    if (!addon || !query) return;
    addon.findPrevious(query, { caseSensitive, wholeWord, regex, decorations });
  }, [activeTabId, query, caseSensitive, wholeWord, regex, decorations]);

  const totalMatches = result?.resultCount ?? 0;
  const currentIndex = result && result.resultCount > 0 ? result.resultIndex : undefined;

  return (
    <SearchBar
      key={activeTabId}
      inputRef={inputRef}
      query={query}
      onQueryChange={setQuery}
      totalMatches={totalMatches}
      currentIndex={currentIndex}
      onPrev={findPrev}
      onNext={findNext}
      onClose={onClose}
      placeholder={t('terminal.searchPlaceholder', 'Find')}
      showIcon={false}
      testIdPrefix="terminal-search"
      caseSensitive={caseSensitive}
      onCaseSensitiveChange={setCaseSensitive}
      wholeWord={wholeWord}
      onWholeWordChange={setWholeWord}
      regex={regex}
      onRegexChange={setRegex}
      className="bg-popover absolute top-2 right-3 z-20 w-104 rounded-md border px-1.5 py-1 shadow-md"
    />
  );
}
