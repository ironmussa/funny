import { describe, expect, test } from 'bun:test';

import {
  defineFunnyDarkTheme,
  FUNNY_DARK_MONACO_THEME,
  FUNNY_DARK_THEME_DATA,
  LIGHT_MONACO_THEME,
  monacoThemeFor,
} from './monaco-theme';

describe('defineFunnyDarkTheme', () => {
  test('registers one funny-dark definition with every editor’s colors', () => {
    const defined: Array<[string, unknown]> = [];
    const monaco = {
      editor: { defineTheme: (name: string, data: unknown) => defined.push([name, data]) },
    };

    defineFunnyDarkTheme(monaco);
    defineFunnyDarkTheme(monaco);

    expect(defined).toHaveLength(2);
    // Every call registers the same data: mount order cannot change the theme.
    for (const [name, data] of defined) {
      expect(name).toBe(FUNNY_DARK_MONACO_THEME);
      expect(data).toBe(FUNNY_DARK_THEME_DATA);
    }
    // Find widget colors (once only the hooks editor had them) and the dotenv
    // tokens (once only the code view had them) live in the one definition.
    expect(FUNNY_DARK_THEME_DATA.colors['editorWidget.background']).toBeDefined();
    expect(FUNNY_DARK_THEME_DATA.colors['inputOption.activeBorder']).toBeDefined();
    expect(FUNNY_DARK_THEME_DATA.rules.map((r) => r.token)).toContain('variable.name.dotenv');
  });
});

describe('monacoThemeFor', () => {
  test('light themes use vs, dark themes and no theme use funny-dark', () => {
    expect(monacoThemeFor('sunrise')).toBe(LIGHT_MONACO_THEME);
    expect(monacoThemeFor('one-dark')).toBe(FUNNY_DARK_MONACO_THEME);
    expect(monacoThemeFor(undefined)).toBe(FUNNY_DARK_MONACO_THEME);
  });
});
