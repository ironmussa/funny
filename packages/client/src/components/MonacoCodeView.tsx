import { Editor, type BeforeMount, type OnMount } from '@monaco-editor/react';

import '@/lib/monaco-setup';
import { defineFunnyDarkTheme } from '@/lib/monaco-theme';

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

  defineFunnyDarkTheme(monaco);

  const compilerOptions: import('monaco-editor').typescript.CompilerOptions = {
    jsx: monaco.typescript.JsxEmit.React,
    jsxFactory: 'React.createElement',
    reactNamespace: 'React',
    allowJs: true,
    allowNonTsExtensions: true,
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    noEmit: true,
  };
  monaco.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
  monaco.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);

  // Monaco's bundled TS worker only sees a single file in isolation (no
  // tsconfig, no project graph), so its diagnostics are misleading: false
  // positives on valid project code and no real cross-file resolution. We use
  // it purely as a viewer/highlighter — the real type/syntax checking is done
  // by the agent via `bun run build`. Disable both validation passes.
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
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
