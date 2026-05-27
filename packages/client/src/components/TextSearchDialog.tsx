import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { HighlightText } from '@/components/ui/highlight-text';
import { Input } from '@/components/ui/input';
import { SearchBar } from '@/components/ui/search-bar';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { FileExtensionIcon } from '@/lib/file-icons';
import { metric } from '@/lib/telemetry';
import { cn } from '@/lib/utils';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useThreadCore } from '@/stores/thread-context';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('text-search-dialog');

interface TextSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEBOUNCE_MS = 250;
const LIST_MAX_HEIGHT_PX = 480;
const FILE_HEADER_ROW = 28;
const MATCH_ROW = 22;

interface FileResult {
  path: string;
  matches: Array<{ line: number; text: string; ranges: Array<{ start: number; end: number }> }>;
}

interface SearchResponse {
  files: FileResult[];
  totalMatches: number;
  truncated: boolean;
  durationMs: number;
  basePath: string;
}

/**
 * Flattened item used by the virtualized list — one entry per visible row
 * (file header OR a single match line). Lets the list keep a constant row
 * height and supports keyboard navigation across files without nested loops.
 */
type FlatRow =
  | { kind: 'file'; fileIndex: number; path: string; matchCount: number; collapsed: boolean }
  | {
      kind: 'match';
      fileIndex: number;
      matchIndex: number;
      path: string;
      line: number;
      text: string;
      ranges: Array<{ start: number; end: number }>;
    };

export function TextSearchDialog({ open, onOpenChange }: TextSearchDialogProps) {
  if (!open) return null;
  return <TextSearchDialogContent open={open} onOpenChange={onOpenChange} />;
}

function TextSearchDialogContent({ open, onOpenChange }: TextSearchDialogProps) {
  const { t } = useTranslation();
  const threadCore = useThreadCore();
  const threadId = threadCore?.id ?? null;

  const persisted = useUIStore((s) => s.textSearchState);
  const setPersisted = useUIStore((s) => s.setTextSearchState);

  // Local mirror of persisted state. We push back to the store on every
  // change so reopening restores everything; we also restore the local copy
  // on every mount from the latest persisted value.
  const [query, setQuery] = useState(persisted.query);
  const [caseSensitive, setCaseSensitive] = useState(persisted.caseSensitive);
  const [wholeWord, setWholeWord] = useState(persisted.wholeWord);
  const [regex, setRegex] = useState(persisted.regex);
  const [include, setInclude] = useState(persisted.include);
  const [exclude, setExclude] = useState(persisted.exclude);

  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [activeRow, setActiveRow] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inflightSeq = useRef(0);

  // Push every option change back into the store so a reopened dialog
  // restores them. The text inputs (query/include/exclude) flush on each
  // keystroke — cheap, debounce is for the network call only.
  useEffect(() => {
    setPersisted({ query, caseSensitive, wholeWord, regex, include, exclude });
  }, [query, caseSensitive, wholeWord, regex, include, exclude, setPersisted]);

  const runSearch = useCallback(async () => {
    if (!threadId) return;
    const q = query.trim();
    if (!q) {
      setResponse(null);
      setError(null);
      return;
    }
    const seq = ++inflightSeq.current;
    setSearching(true);
    setError(null);

    const result = await api.searchText({
      threadId,
      query: q,
      caseSensitive,
      wholeWord,
      regex,
      include: include.trim() || undefined,
      exclude: exclude.trim() || undefined,
    });

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
  }, [threadId, query, caseSensitive, wholeWord, regex, include, exclude]);

  // Debounced search on any input change while open.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(runSearch, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [open, runSearch]);

  const flatRows = useMemo<FlatRow[]>(() => {
    if (!response) return [];
    const rows: FlatRow[] = [];
    response.files.forEach((file, fileIndex) => {
      const isCollapsed = collapsed[file.path] === true;
      rows.push({
        kind: 'file',
        fileIndex,
        path: file.path,
        matchCount: file.matches.length,
        collapsed: isCollapsed,
      });
      if (!isCollapsed) {
        file.matches.forEach((m, matchIndex) => {
          rows.push({
            kind: 'match',
            fileIndex,
            matchIndex,
            path: file.path,
            line: m.line,
            text: m.text,
            ranges: m.ranges,
          });
        });
      }
    });
    return rows;
  }, [response, collapsed]);

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
    [openMatch],
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
    [flatRows, activeRow, activateRow],
  );

  const hasThread = !!threadId;
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
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-[50%] top-[15%] z-50 flex w-full max-w-2xl translate-x-[-50%] flex-col overflow-hidden rounded-lg border bg-card shadow-xl data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
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
              animate={false}
            />
            <div className="flex gap-2">
              <Input
                value={include}
                onChange={(e) => setInclude(e.target.value)}
                placeholder={t('textSearch.include', 'files to include (e.g. *.ts, src/**)')}
                className="h-7 text-xs"
                data-testid="text-search-include"
              />
              <Input
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
                placeholder={t('textSearch.exclude', 'files to exclude')}
                className="h-7 text-xs"
                data-testid="text-search-exclude"
              />
            </div>
          </div>

          <div
            ref={scrollRef}
            className="overflow-y-auto"
            style={{ maxHeight: LIST_MAX_HEIGHT_PX }}
            data-testid="text-search-results"
          >
            {!hasThread ? (
              <EmptyRow text={t('textSearch.noThread', 'Open a thread to search its files')} />
            ) : error ? (
              <EmptyRow text={error} />
            ) : !query.trim() ? (
              <EmptyRow text={t('textSearch.empty', 'Type to search')} />
            ) : searching && flatRows.length === 0 ? (
              <LoadingRow text={t('textSearch.searching', 'Searching...')} />
            ) : flatRows.length === 0 ? (
              <EmptyRow text={t('textSearch.noResults', 'No results')} />
            ) : (
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualizer.getVirtualItems().map((vRow) => {
                  const row = flatRows[vRow.index];
                  if (!row) return null;
                  const isActive = vRow.index === activeRow;
                  return (
                    <div
                      key={vRow.key}
                      role="option"
                      aria-selected={isActive}
                      data-testid={
                        row.kind === 'file'
                          ? `text-search-file-${row.path}`
                          : `text-search-match-${row.path}:${row.line}`
                      }
                      className={cn(
                        'absolute left-0 top-0 flex w-full cursor-pointer items-center px-2',
                        isActive && 'bg-accent text-accent-foreground',
                      )}
                      style={{ height: vRow.size, transform: `translateY(${vRow.start}px)` }}
                      onMouseEnter={() => setActiveRow(vRow.index)}
                      onClick={() => activateRow(row)}
                    >
                      {row.kind === 'file' ? (
                        <FileHeader
                          path={row.path}
                          matchCount={row.matchCount}
                          collapsed={row.collapsed}
                        />
                      ) : (
                        <MatchLine line={row.line} text={row.text} ranges={row.ranges} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {response?.truncated && (
              <div className="border-t px-3 py-1.5 text-center text-xs text-muted-foreground">
                {t('textSearch.truncated', 'Showing first {{count}} matches — refine your search', {
                  count: response.totalMatches,
                })}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function FileHeader({
  path,
  matchCount,
  collapsed,
}: {
  path: string;
  matchCount: number;
  collapsed: boolean;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const slash = path.lastIndexOf('/');
  const filename = slash === -1 ? path : path.slice(slash + 1);
  const dir = slash === -1 ? '' : path.slice(0, slash);
  return (
    <>
      <Chevron className="icon-xs mr-1 shrink-0 opacity-60" />
      <FileExtensionIcon filePath={path} className="icon-base mr-1.5 shrink-0" />
      <span className="truncate text-xs font-medium">{filename}</span>
      {dir && <span className="ml-2 truncate text-xs text-muted-foreground">{dir}</span>}
      <span className="ml-auto pl-2 text-[10px] tabular-nums text-muted-foreground">
        {matchCount}
      </span>
    </>
  );
}

function MatchLine({
  line,
  text,
  ranges,
}: {
  line: number;
  text: string;
  ranges: Array<{ start: number; end: number }>;
}) {
  return (
    <div className="flex w-full min-w-0 items-baseline gap-2 pl-6">
      <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
        {line}
      </span>
      <HighlightText text={text} ranges={ranges} className="truncate font-mono text-xs" />
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="px-3 py-6 text-center text-sm text-muted-foreground">{text}</div>;
}

function LoadingRow({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
      <Loader2 className="icon-sm animate-spin" />
      <span>{text}</span>
    </div>
  );
}
