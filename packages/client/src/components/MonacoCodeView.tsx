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
        [/^\s*[\w.-]+(?==)/, 'variable.name'],
        [/=/, 'delimiter', '@value'],
      ],
      value: [
        [/\\./, 'string.escape'],
        [/\$\{[^}]*\}/, 'variable'],
        [/\$\w+/, 'variable'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/#.*$/, 'comment', '@pop'],
        [/$/, '', '@pop'],
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

  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
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
        wordWrap: 'on',
        fixedOverflowWidgets: true,
      }}
    />
  );
}

export default MonacoCodeView;
