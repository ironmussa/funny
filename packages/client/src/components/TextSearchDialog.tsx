import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { type KeyboardEvent, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SearchBar } from '@/components/ui/search-bar';
import { useInternalEditorStore } from '@/stores/internal-editor-store';

import type { FlatRow } from './text-search/flat-row';
import { TextSearchResults } from './text-search/TextSearchResults';
import { useTextSearch } from './text-search/use-text-search';

interface TextSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TextSearchDialog({ open, onOpenChange }: TextSearchDialogProps) {
  if (!open) return null;
  return <TextSearchDialogContent open={open} onOpenChange={onOpenChange} />;
}

function TextSearchDialogContent({ open, onOpenChange }: TextSearchDialogProps) {
  const { t } = useTranslation();
  const {
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    wholeWord,
    setWholeWord,
    regex,
    setRegex,
    include,
    setInclude,
    exclude,
    setExclude,
    response,
    searching,
    error,
    setCollapsed,
    activeRow,
    setActiveRow,
    flatRows,
    scrollRef,
    virtualizer,
    hasSearchScope,
  } = useTextSearch(open);

  const inputRef = useRef<HTMLInputElement>(null);

  const basePath = response?.basePath;
  const openMatch = useCallback(
    (path: string) => {
      if (!basePath) return;
      const absolutePath = path.startsWith('/') ? path : `${basePath}/${path}`;
      // Persistent UI flow (option 1): open the file but keep the dialog
      // mounted so the user can keep navigating results.
      useInternalEditorStore.getState().openFile(absolutePath);
    },
    [basePath],
  );

  const activateRow = useCallback(
    (row: FlatRow) => {
      if (row.kind === 'file') {
        setCollapsed((c) => ({ ...c, [row.path]: !c[row.path] }));
      } else {
        openMatch(row.path);
      }
    },
    [openMatch, setCollapsed],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (flatRows.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveRow((i) => Math.min(i + 1, flatRows.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveRow((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const row = flatRows[activeRow];
        if (row) activateRow(row);
      }
    },
    [flatRows, activeRow, activateRow, setActiveRow],
  );
  const totalMatches = response?.totalMatches ?? 0;
  const fileCount = response?.files.length ?? 0;
  const resultLabel = query.trim()
    ? totalMatches > 0
      ? t('textSearch.results', '{{matches}} in {{files}} files', {
          matches: totalMatches,
          files: fileCount,
        })
      : searching
        ? ''
        : t('textSearch.noResults', 'No results')
    : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Popup
          aria-describedby={undefined}
          className="bg-card data-closed:animate-fade-out data-open:animate-fade-in fixed top-[15%] left-[50%] z-50 flex w-full max-w-2xl translate-x-[-50%] flex-col overflow-hidden rounded-lg border shadow-xl"
          initialFocus={() => {
            inputRef.current?.focus();
            inputRef.current?.select();
            return false;
          }}
        >
          <DialogTitle className="sr-only">{t('textSearch.title', 'Search in files')}</DialogTitle>

          <div className="flex flex-col gap-2 border-b p-2">
            <SearchBar
              query={query}
              onQueryChange={setQuery}
              totalMatches={totalMatches}
              resultLabel={resultLabel}
              loading={searching}
              caseSensitive={caseSensitive}
              onCaseSensitiveChange={setCaseSensitive}
              wholeWord={wholeWord}
              onWholeWordChange={setWholeWord}
              regex={regex}
              onRegexChange={setRegex}
              onClose={() => onOpenChange(false)}
              onInputKeyDown={handleKeyDown}
              inputRef={inputRef}
              placeholder={t('textSearch.placeholder', 'Search in files...')}
              testIdPrefix="text-search"
            />
            <div className="flex gap-2">
              <Input
                size="xs"
                value={include}
                onChange={(e) => setInclude(e.target.value)}
                placeholder={t('textSearch.include', 'files to include (e.g. *.ts, src/**)')}
                data-testid="text-search-include"
              />
              <Input
                size="xs"
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
                placeholder={t('textSearch.exclude', 'files to exclude')}
                data-testid="text-search-exclude"
              />
            </div>
          </div>

          <TextSearchResults
            hasSearchScope={hasSearchScope}
            error={error}
            query={query}
            searching={searching}
            flatRows={flatRows}
            activeRow={activeRow}
            onActiveRowChange={setActiveRow}
            onActivateRow={activateRow}
            scrollRef={scrollRef}
            virtualizer={virtualizer}
            truncatedCount={response?.truncated ? response.totalMatches : null}
          />
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
