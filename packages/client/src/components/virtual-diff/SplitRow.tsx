import { memo } from 'react';

import {
  getConflictBg,
  GUTTER_BG_ADDED,
  GUTTER_BG_CARD,
  GUTTER_BG_REMOVED,
  H_SCROLL_STYLE,
} from '@/lib/diff/conflict-colors';
import { countTextMatches, getSearchHighlight } from '@/lib/diff/highlight';
import type { DiffLine } from '@/lib/diff/types';
import { cn } from '@/lib/utils';

export const SplitRow = memo(function SplitRow({
  left,
  right,
  lang,
  wrap,
  searchQuery,
  searchCaseSensitive,
  matchOffset,
  currentMatchIdx,
}: {
  left?: DiffLine;
  right?: DiffLine;
  lang: string;
  wrap?: boolean;
  searchQuery?: string;
  searchCaseSensitive?: boolean;
  matchOffset?: number;
  currentMatchIdx?: number;
}) {
  const leftMatches =
    searchQuery && left ? countTextMatches(left.text, searchQuery, searchCaseSensitive) : 0;
  const leftConflictBg = getConflictBg(left?.conflictRole);
  const rightConflictBg = getConflictBg(right?.conflictRole);
  const leftBg =
    leftConflictBg ?? (left?.type === 'del' ? 'hsl(var(--diff-removed) / 0.22)' : undefined);
  const rightBg =
    rightConflictBg ?? (right?.type === 'add' ? 'hsl(var(--diff-added) / 0.22)' : undefined);
  const leftGutterBg =
    leftConflictBg ?? (left?.type === 'del' ? GUTTER_BG_REMOVED : GUTTER_BG_CARD);
  const rightGutterBg =
    rightConflictBg ?? (right?.type === 'add' ? GUTTER_BG_ADDED : GUTTER_BG_CARD);
  return (
    <div
      className="flex font-mono text-[length:var(--diff-font-size)]"
      style={wrap ? { minHeight: 'var(--diff-row-height)' } : { height: 'var(--diff-row-height)' }}
    >
      {/* Left (old) */}
      <div
        className={cn(
          'flex flex-1 border-r border-border/30',
          wrap ? 'items-start overflow-visible' : 'items-center overflow-hidden',
        )}
        style={leftBg ? { backgroundColor: leftBg } : undefined}
        data-pane="left"
      >
        <div
          className="relative z-10 flex flex-shrink-0 items-center"
          style={{ backgroundColor: leftGutterBg }}
        >
          <span className="w-11 flex-shrink-0 select-none pr-1 text-right text-muted-foreground/40">
            {left?.oldNo ?? ''}
          </span>
          <span
            className={cn(
              'w-4 flex-shrink-0 select-none text-center',
              left?.type === 'del' ? 'text-diff-removed' : 'text-foreground/80',
            )}
          >
            {left?.type === 'del' ? '-' : left ? ' ' : ''}
          </span>
        </div>
        {left && (
          <span
            className={cn(
              wrap ? 'whitespace-pre-wrap break-all pr-4' : 'whitespace-pre pr-4',
              left.type === 'del' ? 'text-diff-removed' : 'text-foreground/80',
            )}
            style={wrap ? undefined : H_SCROLL_STYLE}
            dangerouslySetInnerHTML={{
              __html: getSearchHighlight(
                left.text,
                lang,
                searchQuery,
                matchOffset ?? 0,
                currentMatchIdx ?? -1,
                searchCaseSensitive,
              ),
            }}
          />
        )}
      </div>
      {/* Right (new) */}
      <div
        className={cn(
          'flex flex-1',
          wrap ? 'items-start overflow-visible' : 'items-center overflow-hidden',
        )}
        style={rightBg ? { backgroundColor: rightBg } : undefined}
        data-pane="right"
      >
        <div
          className="relative z-10 flex flex-shrink-0 items-center"
          style={{ backgroundColor: rightGutterBg }}
        >
          <span className="w-11 flex-shrink-0 select-none pr-1 text-right text-muted-foreground/40">
            {right?.newNo ?? ''}
          </span>
          <span
            className={cn(
              'w-4 flex-shrink-0 select-none text-center',
              right?.type === 'add' ? 'text-diff-added' : 'text-foreground/80',
            )}
          >
            {right?.type === 'add' ? '+' : right ? ' ' : ''}
          </span>
        </div>
        {right && (
          <span
            className={cn(
              wrap ? 'whitespace-pre-wrap break-all pr-4' : 'whitespace-pre pr-4',
              right.type === 'add' ? 'text-diff-added' : 'text-foreground/80',
            )}
            style={wrap ? undefined : H_SCROLL_STYLE}
            dangerouslySetInnerHTML={{
              __html: getSearchHighlight(
                right.text,
                lang,
                searchQuery,
                (matchOffset ?? 0) + leftMatches,
                currentMatchIdx ?? -1,
                searchCaseSensitive,
              ),
            }}
          />
        )}
      </div>
    </div>
  );
});
