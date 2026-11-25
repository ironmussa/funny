/** Shared scale for loading and empty placeholders across screens and panels. */
export const STATE_ICON_CLASS = 'size-6 shrink-0';
export const STATE_TEXT_CLASS = 'text-sm font-normal';

/** Vertical padding steps for empty and loading placeholders. */
export const STATE_PADDING = {
  sm: 'py-3',
  md: 'py-6',
  lg: 'py-12',
} as const;

export type StatePadding = keyof typeof STATE_PADDING;

/**
 * Surface around a placeholder: none, a settings card, or a dashed outline where
 * the missing items would go (`dashed` pads like a card, `dashed-muted` keeps the padding).
 */
export const STATE_SURFACE = {
  default: '',
  card: 'settings-card',
  dashed: 'rounded-md border border-dashed p-6',
  'dashed-muted': 'rounded-lg border border-dashed border-border/50',
} as const;

export type StateSurface = keyof typeof STATE_SURFACE;
