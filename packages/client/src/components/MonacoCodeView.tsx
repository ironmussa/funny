import { Editor, type BeforeMount, type OnMount } from '@monaco-editor/react';

import '@/lib/monaco-setup';

interface MonacoCodeViewProps {
  language: string;
  theme: string;
  content: string;
  onChange: (value: string) => void;
  onMount: OnMount;
  showMinimap: boolean;
  codeFontSizePx: number;
  /**
   * Word wrap mode. Forced to `'off'` while the blame gutter is shown — Monaco
   * does not paint injected text (the per-line blame annotations) when word
   * wrap is on, and aligned lines read better against blame anyway.
   */
  wordWrap?: 'on' | 'off';
}

let dotenvRegistered = false;

function registerDotenvLanguage(monaco: typeof import('monaco-editor')) {
  if (dotenvRegistered) return;
  dotenvRegistered = true;

  monaco.languages.register({ id: 'dotenv', extensions: ['.env'], aliases: ['dotenv', 'env'] });

  monaco.languages.setMonarchTokensProvider('dotenv', {
    defaultToken: '',
    tokenizer: {
      root: [
        [/^\s*#.*$/, 'comment'],
        [/^(\s*)([A-Za-z_][\w.-]*)(\s*)(=)/, ['white', 'variable.name', 'white', 'delimiter']],
        [/#.*$/, 'comment'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\\./, 'string.escape'],
        [/\$\{[^}]*\}/, 'variable'],
        [/\$[A-Za-z_]\w*/, 'variable'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/-?\b\d+(?:\.\d+)?\b/, 'number'],
        [/[^\s#"'$\\]+/, 'string'],
        [/\s+/, 'white'],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration('dotenv', {
    comments: { lineComment: '#' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '{', close: '}' },
    ],
  });
}

const handleBeforeMount: BeforeMount = (monaco) => {
  registerDotenvLanguage(monaco);

  monaco.editor.defineTheme('funny-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
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
      focusBorder: '#007acc',
    },
  });

  const compilerOptions: import('monaco-editor').typescript.CompilerOptions = {
    jsx: monaco.languages.typescript.JsxEmit.React,
    jsxFactory: 'React.createElement',
    reactNamespace: 'React',
    allowJs: true,
    allowNonTsExtensions: true,
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    noEmit: true,
  };
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);

  // Monaco's bundled TS worker only sees a single file in isolation (no
  // tsconfig, no project graph), so its diagnostics are misleading: false
  // positives on valid project code and no real cross-file resolution. We use
  // it purely as a viewer/highlighter — the real type/syntax checking is done
  // by the agent via `bun run build`. Disable both validation passes.
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
};

export function MonacoCodeView({
  language,
  theme,
  content,
  onChange,
  onMount,
  showMinimap,
  codeFontSizePx,
  wordWrap = 'on',
}: MonacoCodeViewProps) {
  return (
    <Editor
      height="100%"
      language={language}
      theme={theme}
      beforeMount={handleBeforeMount}
      onMount={onMount}
      value={content}
      onChange={(value) => onChange(value || '')}
      options={{
        minimap: { enabled: showMinimap },
        fontSize: codeFontSizePx,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        lineNumbers: 'on',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        wordWrap,
        fixedOverflowWidgets: true,
      }}
    />
  );
}

export default MonacoCodeView;
