import { Editor } from '@monaco-editor/react';
import { useTheme } from 'next-themes';

import '@/lib/monaco-setup';
import { defineFunnyDarkTheme, monacoThemeFor } from '@/lib/monaco-theme';
import { useSettingsStore, EDITOR_FONT_SIZE_PX } from '@/stores/settings-store';

/* ── Inline shell editor (Monaco) ── */

export function ShellEditor({
  value,
  onChange,
  testId,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  testId?: string;
  ariaLabel: string;
}) {
  const { resolvedTheme } = useTheme();
  const codeFontSizePx = EDITOR_FONT_SIZE_PX[useSettingsStore((s) => s.fontSize)];
  const monacoTheme = monacoThemeFor(resolvedTheme);
  const lineCount = Math.max(value.split('\n').length, 3);
  const height = Math.min(Math.max(lineCount * 22 + 16, 100), 400);

  return (
    <div className="border-input overflow-hidden rounded-md border" data-testid={testId}>
      <Editor
        height={height}
        language="shell"
        theme={monacoTheme}
        beforeMount={defineFunnyDarkTheme}
        value={value}
        onChange={(v) => onChange(v ?? '')}
        options={{
          minimap: { enabled: false },
          fontSize: codeFontSizePx,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          lineNumbers: 'off',
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 8,
          lineNumbersMinChars: 0,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          automaticLayout: true,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: { vertical: 'auto', horizontal: 'hidden', verticalScrollbarSize: 8 },
          renderLineHighlight: 'none',
          ariaLabel,
          padding: { top: 6, bottom: 6 },
        }}
      />
    </div>
  );
}
