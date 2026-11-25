import type { DockviewTheme } from 'dockview-react';

import { isLightTheme } from '@/lib/theme';

/**
 * Custom dockview theme bound to the app's shadcn tokens. The actual CSS vars
 * live in globals.css (`.dockview-theme-funny`) and auto-switch with the app's
 * light/dark theme via shadcn's HSL variable set, so we don't need to swap
 * theme objects when the user changes color scheme.
 */
const themeFunnyLight: DockviewTheme = {
  name: 'funny-light',
  className: 'dockview-theme-funny',
  colorScheme: 'light',
  tabGroupIndicator: 'none',
};
const themeFunnyDark: DockviewTheme = {
  name: 'funny-dark',
  className: 'dockview-theme-funny',
  colorScheme: 'dark',
  tabGroupIndicator: 'none',
};

/** The funny dockview theme for the app's resolved light/dark theme. */
export function dockviewThemeFor(resolvedTheme: string | undefined): DockviewTheme {
  return isLightTheme(resolvedTheme) ? themeFunnyLight : themeFunnyDark;
}
