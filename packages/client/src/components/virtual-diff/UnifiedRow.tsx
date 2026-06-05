import { memo } from 'react';

import { TriCheckbox } from '@/components/ui/tri-checkbox';
import {
  getConflictMarkerDisplayText,
  getUnifiedRowBgStyle,
  getUnifiedRowTextClass,
  isConflictMarkerLine,
} from '@/lib/diff/conflict-colors';
import { getSearchHighlight } from '@/lib/diff/highlight';
import type { DiffLine } from '@/lib/diff/types';
import { cn } from '@/lib/utils';

export const UnifiedRow = memo(function UnifiedRow({
  line,
  lineIdx,
  lang,
  wrap,
  searchQuery,
  searchCaseSensitive,
  matchOffset,
  currentMatchIdx,
  selectable,
  selected,
  onToggle,
}: {
  line: DiffLine;
  lineIdx?: number;
  lang: string;
  wrap?: boolean;
  searchQuery?: string;
  searchCaseSensitive?: boolean;
  matchOffset?: number;
  currentMatchIdx?: number;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (lineIdx: number) => void;
}) {
  const bgStyle = getUnifiedRowBgStyle(line);
  const isConflictMarker = isConflictMarkerLine(line);
  const textClass = getUnifiedRowTextClass(line);
  const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  const isChangeLine = line.type === 'add' || line.type === 'del';
  const displayText = getConflictMarkerDisplayText(line);

  return (
    <div
      className={cn(
        'flex font-mono text-(length:--diff-font-size)',
        wrap ? 'items-start' : 'items-center',
        selectable && 'pl-1',
      )}
      style={
        wrap
          ? { minHeight: 'var(--diff-row-height)', ...bgStyle }
          : { height: 'var(--diff-row-height)', ...bgStyle }
      }
      {...(selectable && isChangeLine && lineIdx != null ? { 'data-line-idx': lineIdx } : {})}
    >
      {selectable && (
        <span className="flex w-5 shrink-0 items-center justify-center" data-gutter>
          {isChangeLine && (
            <TriCheckbox
              state={selected ? 'checked' : 'unchecked'}
              onToggle={() => lineIdx != null && onToggle?.(lineIdx)}
              data-testid={`diff-line-checkbox-${lineIdx}`}
            />
          )}
        </span>
      )}
      <span
        className="text-muted-foreground/40 w-11 shrink-0 pt-px pr-1 text-right select-none"
        data-gutter
      >
        {line.oldNo ?? ''}
      </span>
      <span
        className="text-muted-foreground/40 w-11 shrink-0 pt-px pr-1 text-right select-none"
        data-gutter
      >
        {line.newNo ?? ''}
      </span>
      <span className={cn('w-4 shrink-0 select-none pt-px text-center', textClass)}>{prefix}</span>
      <span
        className={cn(
          wrap ? 'whitespace-pre-wrap break-all pr-4' : 'whitespace-pre pr-4',
          textClass,
        )}
        dangerouslySetInnerHTML={{
          __html: getSearchHighlight(
            displayText,
            isConflictMarker ? 'plaintext' : lang,
            searchQuery,
            matchOffset ?? 0,
            currentMatchIdx ?? -1,
            searchCaseSensitive,
          ),
        }}
      />
    </div>
  );
});
