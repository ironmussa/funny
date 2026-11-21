import { describe, expect, test } from 'vitest';

import { isLightTheme, THEME_CLASSES, THEMES } from './theme';

describe('isLightTheme', () => {
  const expected: Record<(typeof THEMES)[number], boolean> = {
    'one-dark': false,
    dracula: false,
    'github-dark': false,
    'night-owl': false,
    catppuccin: false,
    sunrise: true,
    monochrome: true,
    'monochrome-dark': false,
    minimal: false,
  };

  test.each(THEMES.map((t) => [t, expected[t]] as const))('%s → light=%s', (theme, light) => {
    expect(isLightTheme(theme)).toBe(light);
  });

  test('every registered theme has an expectation and a class', () => {
    expect(Object.keys(expected).sort()).toEqual([...THEMES].sort());
    for (const t of THEMES) expect(THEME_CLASSES[t]).toBe(`theme-${t}`);
  });

  test('unknown or missing themes are dark', () => {
    expect(isLightTheme('light')).toBe(false);
    expect(isLightTheme(undefined)).toBe(false);
    expect(isLightTheme(null)).toBe(false);
  });
});
