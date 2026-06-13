/**
 * Single source of truth for interactive control sizing.
 *
 * Buttons, inputs and selects all read their height / horizontal padding /
 * text size from this scale, so `size="sm"` (or any other name) renders the
 * SAME height across every form control. Before this existed each primitive
 * defined its own height map and the names disagreed (a `Button size="sm"` was
 * 36px while a `Select size="sm"` was 32px), which is why rows of mixed
 * controls never lined up.
 *
 * App default density is `sm` (32px) — a compact, IDE-like baseline that suits
 * dense lists, settings rows and dialogs. Reach for `md` when a control needs
 * a more comfortable / touch-friendly target, and `lg` for hero CTAs.
 *
 * ── Scale ──────────────────────────────────────────────────────────────
 *   xs → h-7  (28px) · dense toolbars, inline chips
 *   sm → h-8  (32px) · DEFAULT — rows, settings, dialogs
 *   md → h-9  (36px) · comfortable / touch
 *   lg → h-10 (40px) · hero / primary CTA
 * ──────────────────────────────────────────────────────────────────────── */

/** Field-like controls (input / select trigger / text button): height + padding-x + text. */
export const FIELD_SIZE = {
  xs: 'h-7 px-2 text-xs',
  sm: 'h-8 px-3 text-sm',
  md: 'h-9 px-3 text-sm',
  lg: 'h-10 px-4 text-base',
} as const;

/** Square icon buttons — width === height, no horizontal padding. */
export const ICON_SIZE = {
  xs: 'size-7',
  sm: 'size-8',
  md: 'size-9',
  lg: 'size-10',
} as const;

/** Icon glyph size paired to each control size (matches the `icon-*` utilities in globals.css). */
export const CONTROL_ICON = {
  xs: '[&_svg]:size-3',
  sm: '[&_svg]:size-3.5',
  md: '[&_svg]:size-4',
  lg: '[&_svg]:size-4',
} as const;

export type ControlSize = keyof typeof FIELD_SIZE;
