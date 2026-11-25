import { memo } from 'react';

import {
  getConflictBg,
  GUTTER_BG_ADDED,
  GUTTER_BG_CARD,
  GUTTER_BG_REMOVED,
} from '@/lib/diff/conflict-colors';
import { countTextMatches, getDiffHighlight, getSearchHighlight } from '@/lib/diff/highlight';
import type { DiffLine } from '@/lib/diff/types';
import { cn } from '@/lib/utils';

export const ThreePaneRow = memo(function ThreePaneRow({
  left,
  center,
  right,
  lang,
  wrap,
  searchQuery,
  searchCaseSensitive,
  matchOffset,
  currentMatchIdx,
}: {
  left?: DiffLine;
  center?: DiffLine;
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
  const centerMatches =
    searchQuery && center ? countTextMatches(center.text, searchQuery, searchCaseSensitive) : 0;
  const align = wrap ? 'items-start overflow-visible' : 'items-center overflow-hidden';
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
      className={cn(
        'flex font-mono text-(length:--diff-font-size)',
        wrap ? 'min-h-[var(--diff-row-height)]' : 'h-[var(--diff-row-height)]',
      )}
    >
      {/* Left (old) */}
      <div
        className={cn(
          'flex flex-1 border-r border-border/30',
          align,
          leftBg && 'bg-[color:var(--three-pane-pane-bg)]',
        )}
        style={leftBg ? { '--three-pane-pane-bg': leftBg } : undefined}
        data-pane="left"
      >
        <div
          className="relative z-10 flex shrink-0 items-center bg-[color:var(--three-pane-gutter-bg)]"
          style={{ '--three-pane-gutter-bg': leftGutterBg }}
        >
          <span className="text-muted-foreground/40 w-11 shrink-0 pr-1 text-right select-none">
            {left?.oldNo ?? ''}
          </span>
          <span
            className={cn(
              'w-4 shrink-0 select-none text-center',
              left?.type === 'del' ? 'text-diff-removed' : 'text-foreground/80',
            )}
          >
            {left?.type === 'del' ? '-' : left ? ' ' : ''}
          </span>
        </div>
        {left && (
          <span
            className={cn(
              wrap ? 'whitespace-pre-wrap break-all pr-2' : 'whitespace-pre pr-2',
              !wrap && 'relative z-0 [transform:translateX(calc(-1*var(--h-scroll,0px)))]',
              left.type === 'del' ? 'text-diff-removed' : 'text-foreground/80',
            )}
            dangerouslySetInnerHTML={{
              __html: getDiffHighlight(
                left.text,
                lang,
                left.segments,
                'diff-word-del',
                searchQuery,
                matchOffset ?? 0,
                currentMatchIdx ?? -1,
                searchCaseSensitive,
              ),
            }}
          />
        )}
      </div>
      {/* Center (result — clean, no diff highlighting) */}
      <div className={cn('flex flex-1 border-r border-border/30', align)} data-pane="center">
        <div
          className="relative z-10 flex shrink-0 items-center bg-[color:var(--three-pane-gutter-bg)]"
          style={{ '--three-pane-gutter-bg': GUTTER_BG_CARD }}
        >
          <span className="text-muted-foreground/40 w-11 shrink-0 pr-1 text-right select-none">
            {center?.newNo ?? ''}
          </span>
        </div>
        {center && (
          <span
            className={cn(
              wrap
                ? 'text-foreground pr-2 break-all whitespace-pre-wrap'
                : 'text-foreground pr-2 whitespace-pre',
              !wrap && 'relative z-0 [transform:translateX(calc(-1*var(--h-scroll,0px)))]',
            )}
            dangerouslySetInnerHTML={{
              __html: getSearchHighlight(
                center.text,
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
      {/* Right (new) */}
      <div
        className={cn('flex flex-1', align, rightBg && 'bg-[color:var(--three-pane-pane-bg)]')}
        style={rightBg ? { '--three-pane-pane-bg': rightBg } : undefined}
        data-pane="right"
      >
        <div
          className="relative z-10 flex shrink-0 items-center bg-[color:var(--three-pane-gutter-bg)]"
          style={{ '--three-pane-gutter-bg': rightGutterBg }}
        >
          <span className="text-muted-foreground/40 w-11 shrink-0 pr-1 text-right select-none">
            {right?.newNo ?? ''}
          </span>
          <span
            className={cn(
              'w-4 shrink-0 select-none text-center',
              right?.type === 'add' ? 'text-diff-added' : 'text-foreground/80',
            )}
          >
            {right?.type === 'add' ? '+' : right ? ' ' : ''}
          </span>
        </div>
        {right && (
          <span
            className={cn(
              wrap ? 'whitespace-pre-wrap break-all pr-2' : 'whitespace-pre pr-2',
              !wrap && 'relative z-0 [transform:translateX(calc(-1*var(--h-scroll,0px)))]',
              right.type === 'add' ? 'text-diff-added' : 'text-foreground/80',
            )}
            dangerouslySetInnerHTML={{
              __html: getDiffHighlight(
                right.text,
                lang,
                right.segments,
                'diff-word-add',
                searchQuery,
                (matchOffset ?? 0) + leftMatches + centerMatches,
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
