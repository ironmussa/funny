import type { FontSizePreference } from '@funny/client-core/stores/preferences';

export interface FontSizeCssValues {
  root: string;
  diff: number;
  diffRow: number;
  code: number;
}

export function applyWebFontSize(
  size: FontSizePreference,
  values: Record<FontSizePreference, FontSizeCssValues>,
): void {
  const selected = values[size];
  document.documentElement.style.fontSize = selected.root;
  document.documentElement.style.setProperty('--diff-font-size', `${selected.diff}px`);
  document.documentElement.style.setProperty('--diff-row-height', `${selected.diffRow}px`);
  document.documentElement.style.setProperty('--code-font-size', `${selected.code}px`);
}
