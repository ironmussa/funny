import type { ConflictRole, DiffLine } from './types';

/* ── Conflict colors ── */

export const CONFLICT_OURS_BG = 'hsl(210 80% 55% / 0.15)';
export const CONFLICT_OURS_MARKER_BG = 'hsl(210 80% 55% / 0.30)';
export const CONFLICT_THEIRS_BG = 'hsl(30 80% 55% / 0.15)';
export const CONFLICT_THEIRS_MARKER_BG = 'hsl(30 80% 55% / 0.30)';
export const CONFLICT_SEP_BG = 'hsl(0 0% 50% / 0.25)';

export function getConflictBg(role?: ConflictRole): string | undefined {
  switch (role) {
    case 'marker-start':
      return CONFLICT_OURS_MARKER_BG;
    case 'ours':
      return CONFLICT_OURS_BG;
    case 'separator':
      return CONFLICT_SEP_BG;
    case 'theirs':
      return CONFLICT_THEIRS_BG;
    case 'marker-end':
      return CONFLICT_THEIRS_MARKER_BG;
    default:
      return undefined;
  }
}

/**
 * Opaque gutter backgrounds — composites the semi-transparent diff tint over
 * the card background so the gutter blocks h-scrolled text while matching
 * the row's visual color exactly.
 */
export const GUTTER_BG_CARD = 'hsl(var(--card))';
export const GUTTER_BG_ADDED = 'color-mix(in srgb, hsl(var(--diff-added)) 22%, hsl(var(--card)))';
export const GUTTER_BG_REMOVED =
  'color-mix(in srgb, hsl(var(--diff-removed)) 22%, hsl(var(--card)))';

/** Inline style for pane text when horizontal scroll is active (CSS variable driven).
 * position:relative + z-index:0 ensures the text stays BELOW the gutter (z-10). */
export const H_SCROLL_STYLE: React.CSSProperties = {
  transform: 'translateX(calc(-1 * var(--h-scroll, 0px)))',
  position: 'relative',
  zIndex: 0,
};

/**
 * Compute the unified-row background inline style for a DiffLine.
 * Returns undefined when there is no background to apply (context line, no conflict).
 */
export function getUnifiedRowBgStyle(line: DiffLine): React.CSSProperties | undefined {
  const conflictBg = getConflictBg(line.conflictRole);
  if (conflictBg) return { backgroundColor: conflictBg };
  if (line.type === 'add') return { backgroundColor: 'hsl(var(--diff-added) / 0.22)' };
  if (line.type === 'del') return { backgroundColor: 'hsl(var(--diff-removed) / 0.22)' };
  return undefined;
}

/** Whether a DiffLine's conflictRole is one of the visual marker boundaries. */
export function isConflictMarkerLine(line: DiffLine): boolean {
  return (
    line.conflictRole === 'marker-start' ||
    line.conflictRole === 'separator' ||
    line.conflictRole === 'marker-end'
  );
}

/** Tailwind class expressing the text color for a DiffLine in unified view. */
export function getUnifiedRowTextClass(line: DiffLine): string {
  if (isConflictMarkerLine(line)) return 'text-muted-foreground/60 italic';
  if (line.conflictRole === 'ours') return 'text-blue-300';
  if (line.conflictRole === 'theirs') return 'text-orange-300';
  if (line.type === 'add') return 'text-diff-added';
  if (line.type === 'del') return 'text-diff-removed';
  return 'text-foreground/80';
}

/**
 * Return the readable label to render for a conflict marker line
 * (so the user sees a friendly `── Current Change (HEAD) ──` instead of raw
 * `<<<<<<< HEAD`). For non-marker lines, returns the unmodified text.
 */
export function getConflictMarkerDisplayText(line: DiffLine): string {
  if (!isConflictMarkerLine(line)) return line.text;
  if (line.conflictRole === 'marker-start') {
    return `── Current Change (${line.text.replace(/^<{7}\s?/, '').trim() || 'HEAD'}) ──`;
  }
  if (line.conflictRole === 'separator') {
    return '────────────────────────────────';
  }
  return `── Incoming Change (${line.text.replace(/^>{7}\s?/, '').trim() || 'branch'}) ──`;
}
