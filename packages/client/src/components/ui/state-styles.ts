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
