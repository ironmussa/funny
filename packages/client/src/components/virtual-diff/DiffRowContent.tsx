import type { RenderRow, VirtualDiffProps } from '@/lib/diff/types';
import { cn } from '@/lib/utils';

import { ConflictActionBar } from './ConflictActionBar';
import { HunkCheckbox } from './HunkCheckbox';
import { SplitRow } from './SplitRow';
import { ThreePaneRow } from './ThreePaneRow';
import { UnifiedRow } from './UnifiedRow';

export interface DiffRowContentProps extends Pick<
  VirtualDiffProps,
  | 'selectedLines'
  | 'onHunkToggle'
  | 'onLineToggle'
  | 'onResolveConflict'
  | 'searchQuery'
  | 'searchCaseSensitive'
> {
  row: RenderRow;
  rowHeight: number;
  selectable: boolean;
  hunkLineMap: Map<number, number[]>;
  gutterWidth: string;
  toggleFold: (sectionIdx: number) => void;
  highlightLang: string;
  wordWrap: boolean;
  matchOffset: number | undefined;
  currentMatchIndex: number;
}

type RowOf<T extends RenderRow['type']> = Extract<RenderRow, { type: T }>;

type HunkGutterProps = Pick<
  DiffRowContentProps,
  'selectable' | 'hunkLineMap' | 'selectedLines' | 'onHunkToggle'
> & { hunkStartIdx: number | undefined };

/** The hunk header's checkbox slot: a checkbox when lines are selectable. */
function HunkGutter({
  selectable,
  hunkStartIdx,
  hunkLineMap,
  selectedLines,
  onHunkToggle,
}: HunkGutterProps) {
  if (!selectable) return null;
  if (hunkStartIdx == null) return <span className="w-5 shrink-0" />;
  return (
    <HunkCheckbox
      indices={hunkLineMap.get(hunkStartIdx) ?? []}
      selectedLines={selectedLines}
      onHunkToggle={onHunkToggle}
      testId={`diff-hunk-checkbox-${hunkStartIdx}`}
    />
  );
}

function HunkRow({ row, ...props }: DiffRowContentProps & { row: RowOf<'hunk'> }) {
  return (
    <div
      className={cn(
        'flex select-none items-center bg-accent font-mono text-(length:--diff-font-size) text-muted-foreground px-1',
        'h-[var(--vdiff-row-height)]',
      )}
    >
      <HunkGutter
        selectable={props.selectable}
        hunkStartIdx={row.hunkStartIdx}
        hunkLineMap={props.hunkLineMap}
        selectedLines={props.selectedLines}
        onHunkToggle={props.onHunkToggle}
      />
      <span className={cn(props.gutterWidth, 'shrink-0')} />
      <span className="truncate">{row.text}</span>
    </div>
  );
}

function FoldRow({ row, ...props }: DiffRowContentProps & { row: RowOf<'fold'> }) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full select-none items-center bg-muted/50 font-mono text-(length:--diff-font-size) text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground px-1',
        'h-[var(--vdiff-row-height)]',
      )}
      onClick={() => props.toggleFold(row.sectionIdx)}
      data-testid="diff-fold-toggle"
    >
      {props.selectable && <span className="w-5 shrink-0" />}
      <span className={cn(props.gutterWidth, 'shrink-0')} />
      <span className="truncate">
        @@ -{row.oldStart},{row.lineCount} +{row.newStart},{row.lineCount} @@ · {row.lineCount}{' '}
        lines hidden
      </span>
    </button>
  );
}

function UnifiedLineRow({ row, ...props }: DiffRowContentProps & { row: RowOf<'unified-line'> }) {
  return (
    <UnifiedRow
      line={row.line}
      lineIdx={row.lineIdx}
      lang={props.highlightLang}
      wrap={props.wordWrap}
      searchQuery={props.searchQuery}
      searchCaseSensitive={props.searchCaseSensitive}
      matchOffset={props.matchOffset}
      currentMatchIdx={props.currentMatchIndex}
      selectable={props.selectable}
      selected={props.selectable ? props.selectedLines?.has(row.lineIdx) : undefined}
      onToggle={props.onLineToggle}
    />
  );
}

/** The content of one virtual row of `VirtualDiff`, chosen by the row's type. */
export function DiffRowContent(props: DiffRowContentProps) {
  const { row } = props;
  if (row.type === 'conflict-actions') {
    return <ConflictActionBar block={row.block} onResolve={props.onResolveConflict} />;
  }
  if (row.type === 'hunk') return <HunkRow {...props} row={row} />;
  if (row.type === 'fold') return <FoldRow {...props} row={row} />;
  if (row.type === 'three-pane-triple') {
    return (
      <ThreePaneRow
        left={row.triple.left}
        center={row.triple.center}
        right={row.triple.right}
        lang={props.highlightLang}
        wrap={props.wordWrap}
        searchQuery={props.searchQuery}
        searchCaseSensitive={props.searchCaseSensitive}
        matchOffset={props.matchOffset}
        currentMatchIdx={props.currentMatchIndex}
      />
    );
  }
  if (row.type === 'split-pair') {
    return (
      <SplitRow
        left={row.pair.left}
        right={row.pair.right}
        lang={props.highlightLang}
        wrap={props.wordWrap}
        searchQuery={props.searchQuery}
        searchCaseSensitive={props.searchCaseSensitive}
        matchOffset={props.matchOffset}
        currentMatchIdx={props.currentMatchIndex}
      />
    );
  }
  return <UnifiedLineRow {...props} row={row} />;
}
