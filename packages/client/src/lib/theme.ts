/**
 * The app's registered themes (next-themes names) and which of them are light.
 * Use `isLightTheme()` wherever a third-party widget (Monaco, toasts, dockview,
 * visualizers) needs a light/dark choice, instead of comparing theme names.
 */
export const THEMES = [
  'one-dark',
  'dracula',
  'github-dark',
  'night-owl',
  'catppuccin',
  'sunrise',
  'monochrome',
  'monochrome-dark',
  'minimal',
] as const;

export type ThemeName = (typeof THEMES)[number];

/** Class applied to `<html>` for each theme. */
// SAFETY: THEMES.map builds one entry for every ThemeName, so the object has
// every key of the record.
export const THEME_CLASSES: Record<ThemeName, string> = Object.fromEntries(
  THEMES.map((t) => [t, `theme-${t}`]),
) as Record<ThemeName, string>;

const LIGHT_THEMES: ReadonlySet<string> = new Set<ThemeName>(['sunrise', 'monochrome']);

/** True when the resolved theme has a light background. */
export function isLightTheme(theme: string | undefined | null): boolean {
  return theme != null && LIGHT_THEMES.has(theme);
}
