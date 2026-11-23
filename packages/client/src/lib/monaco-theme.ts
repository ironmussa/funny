/**
 * The one definition of funny's dark Monaco theme.
 *
 * `monaco.editor.defineTheme` registers a theme GLOBALLY: every editor on the
 * page that uses the name gets the last definition. When each editor defined
 * its own `funny-dark`, an open editor's colors depended on which editor
 * mounted last. Every `<Editor>` must pass `beforeMount={defineFunnyDarkTheme}`
 * (or call it from its own `beforeMount`) and pick its theme with
 * `monacoThemeFor`, so all of them share this definition.
 *
 * Monaco only accepts literal hex colors, so they live here and nowhere else.
 */
import { isLightTheme } from './theme';

export const FUNNY_DARK_MONACO_THEME = 'funny-dark';
export const LIGHT_MONACO_THEME = 'vs';

/** Structural subset of `monaco.editor.IStandaloneThemeData`. */
interface MonacoThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  inherit: boolean;
  rules: { token: string; foreground?: string; fontStyle?: string }[];
  colors: Record<string, string>;
}

/** Structural subset of the `monaco` namespace that `defineTheme` needs. */
interface MonacoWithThemes {
  editor: { defineTheme(name: string, data: MonacoThemeData): void };
}

export const FUNNY_DARK_THEME_DATA: MonacoThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // `dotenv` language (registered by MonacoCodeView).
    { token: 'variable.name.dotenv', foreground: '9CDCFE' },
    { token: 'delimiter.dotenv', foreground: 'D4D4D4' },
    { token: 'string.dotenv', foreground: 'CE9178' },
    { token: 'variable.dotenv', foreground: '4FC1FF' },
    { token: 'string.escape.dotenv', foreground: 'D7BA7D' },
    { token: 'comment.dotenv', foreground: '6A9955', fontStyle: 'italic' },
    { token: 'keyword.dotenv', foreground: '569CD6' },
    { token: 'number.dotenv', foreground: 'B5CEA8' },
  ],
  colors: {
    'editor.background': '#000000',
    'editorGutter.background': '#000000',
    'minimap.background': '#0a0a0a',
    // Find widget
    'editorWidget.background': '#1e1e1e',
    'editorWidget.border': '#454545',
    'editorWidget.foreground': '#cccccc',
    'input.background': '#2a2a2a',
    'input.foreground': '#cccccc',
    'input.border': '#454545',
    'inputOption.activeBorder': '#007acc',
    'inputOption.activeBackground': '#007acc44',
    'inputOption.activeForeground': '#ffffff',
    focusBorder: '#007acc',
  },
};

/** Registers `funny-dark`. Idempotent: always registers the same data. */
export function defineFunnyDarkTheme(monaco: MonacoWithThemes): void {
  monaco.editor.defineTheme(FUNNY_DARK_MONACO_THEME, FUNNY_DARK_THEME_DATA);
}

/** The Monaco theme name for the app's resolved theme. */
export function monacoThemeFor(resolvedTheme: string | undefined | null): string {
  return isLightTheme(resolvedTheme) ? LIGHT_MONACO_THEME : FUNNY_DARK_MONACO_THEME;
}
