import type { Virtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { HighlightText } from '@/components/ui/highlight-text';
import { SearchEmptyRow as EmptyRow, SearchLoadingRow } from '@/components/ui/search-placeholder';
import { FileExtensionIcon } from '@/lib/file-icons';
import { cn } from '@/lib/utils';

import type { FlatRow } from './flat-row';

interface TextSearchResultsProps {
  hasSearchScope: boolean;
  error: string | null;
  query: string;
  searching: boolean;
  flatRows: FlatRow[];
  activeRow: number;
  onActiveRowChange: (index: number) => void;
  onActivateRow: (row: FlatRow) => void;
  truncatedCount: number | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
}

type PlaceholderKind = 'no-scope' | 'error' | 'empty-query' | 'searching' | 'no-results';

interface PlaceholderInput {
  hasSearchScope: boolean;
  error: string | null;
  query: string;
  searching: boolean;
  rowCount: number;
}

/** Which placeholder replaces the rows, or `null` when there are rows to show. */
function placeholderKind({
  hasSearchScope,
  error,
  query,
  searching,
  rowCount,
}: PlaceholderInput): PlaceholderKind | null {
  if (!hasSearchScope) return 'no-scope';
  if (error) return 'error';
  if (!query.trim()) return 'empty-query';
  if (rowCount > 0) return null;
  return searching ? 'searching' : 'no-results';
}

function ResultsPlaceholder({ kind, error }: { kind: PlaceholderKind; error: string | null }) {
  const { t } = useTranslation();
  if (kind === 'searching') return <LoadingRow text={t('textSearch.searching', 'Searching...')} />;
  const texts: Record<Exclude<PlaceholderKind, 'searching'>, string> = {
    'no-scope': t('textSearch.noScope', 'Open a thread or project to search its files'),
    error: error ?? '',
    'empty-query': t('textSearch.empty', 'Type to search'),
    'no-results': t('textSearch.noResults', 'No results'),
  };
  return <EmptyRow text={texts[kind]} />;
}

function rowTestId(row: FlatRow): string {
  return row.kind === 'file'
    ? `text-search-file-${row.path}`
    : `text-search-match-${row.path}:${row.line}`;
}

interface ResultRowProps {
  row: FlatRow;
  index: number;
  size: number;
  start: number;
  isActive: boolean;
  onActiveRowChange: (index: number) => void;
  onActivateRow: (row: FlatRow) => void;
}

function ResultRow({
  row,
  index,
  size,
  start,
  isActive,
  onActiveRowChange,
  onActivateRow,
}: ResultRowProps) {
  return (
    <div
      role="option"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      data-testid={rowTestId(row)}
      className={cn(
        'absolute left-0 top-0 flex h-[var(--text-search-row-height)] w-full cursor-pointer items-center [transform:translateY(var(--text-search-row-start))] px-2',
        isActive && 'bg-accent text-accent-foreground',
      )}
      style={{
        '--text-search-row-height': `${size}px`,
        '--text-search-row-start': `${start}px`,
      }}
      onMouseEnter={() => onActiveRowChange(index)}
      onClick={() => onActivateRow(row)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onActivateRow(row);
      }}
    >
      {row.kind === 'file' ? (
        <FileHeader path={row.path} matchCount={row.matchCount} collapsed={row.collapsed} />
      ) : (
        <MatchLine line={row.line} text={row.text} ranges={row.ranges} />
      )}
    </div>
  );
}

type VirtualRowsProps = Pick<
  TextSearchResultsProps,
  'flatRows' | 'activeRow' | 'onActiveRowChange' | 'onActivateRow' | 'virtualizer'
>;

function VirtualRows({
  flatRows,
  activeRow,
  onActiveRowChange,
  onActivateRow,
  virtualizer,
}: VirtualRowsProps) {
  return (
    <div
      className="relative h-[var(--text-search-list-height)] w-full"
      style={{ '--text-search-list-height': `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((vRow) => {
        const row = flatRows[vRow.index];
        if (!row) return null;
        return (
          <ResultRow
            key={vRow.key}
            row={row}
            index={vRow.index}
            size={vRow.size}
            start={vRow.start}
            isActive={vRow.index === activeRow}
            onActiveRowChange={onActiveRowChange}
            onActivateRow={onActivateRow}
          />
        );
      })}
    </div>
  );
}

/** Virtualized result list of the text search dialog. */
export function TextSearchResults({
  hasSearchScope,
  error,
  query,
  searching,
  truncatedCount,
  scrollRef,
  ...rows
}: TextSearchResultsProps) {
  const { t } = useTranslation();
  const placeholder = placeholderKind({
    hasSearchScope,
    error,
    query,
    searching,
    rowCount: rows.flatRows.length,
  });

  return (
    <div
      ref={scrollRef}
      className="max-h-[480px] overflow-y-auto"
      data-testid="text-search-results"
    >
      {placeholder ? (
        <ResultsPlaceholder kind={placeholder} error={error} />
      ) : (
        <VirtualRows {...rows} />
      )}
      {truncatedCount !== null && (
        <div className="text-muted-foreground border-t px-3 py-1.5 text-center text-xs">
          {t('textSearch.truncated', 'Showing first {{count}} matches — refine your search', {
            count: truncatedCount,
          })}
        </div>
      )}
    </div>
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
      {dir && <span className="text-muted-foreground ml-2 truncate text-xs">{dir}</span>}
      <span className="text-muted-foreground text-2xs ml-auto pl-2 tabular-nums">{matchCount}</span>
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
      <span className="text-muted-foreground text-2xs w-10 shrink-0 text-right tabular-nums">
        {line}
      </span>
      <HighlightText text={text} ranges={ranges} className="truncate font-mono text-xs" />
    </div>
  );
}

function LoadingRow({ text }: { text: string }) {
  return <SearchLoadingRow text={text} testId="text-search-loading" />;
}
