import { describe, test, expect } from 'vitest';

import { parseCatOutput } from '@/lib/parse-cat-output';

describe('parseCatOutput', () => {
  describe('tab separator', () => {
    test('strips line numbers with tab separator', () => {
      const input = '     1\tconst x = 1;\n     2\tconst y = 2;';
      const result = parseCatOutput(input);
      expect(result.code).toBe('const x = 1;\nconst y = 2;');
      expect(result.startLine).toBe(1);
    });

    test('handles single-digit line numbers', () => {
      const input = '     1\thello';
      const result = parseCatOutput(input);
      expect(result.code).toBe('hello');
      expect(result.startLine).toBe(1);
    });

    test('handles multi-digit line numbers', () => {
      const input = '   100\tline hundred\n   101\tline hundred one';
      const result = parseCatOutput(input);
      expect(result.code).toBe('line hundred\nline hundred one');
      expect(result.startLine).toBe(100);
    });
  });

  describe('arrow separator (U+2192)', () => {
    test('strips line numbers with arrow separator', () => {
      const input = '     1\u2192const x = 1;\n     2\u2192const y = 2;';
      const result = parseCatOutput(input);
      expect(result.code).toBe('const x = 1;\nconst y = 2;');
      expect(result.startLine).toBe(1);
    });

    test('handles mixed arrow content', () => {
      const input = '     5\u2192function foo() {\n     6\u2192  return 42;\n     7\u2192}';
      const result = parseCatOutput(input);
      expect(result.code).toBe('function foo() {\n  return 42;\n}');
      expect(result.startLine).toBe(5);
    });
  });

  describe('multi-line output', () => {
    test('preserves indentation in content', () => {
      const input =
        '     1\tfunction foo() {\n     2\t  if (true) {\n     3\t    return;\n     4\t  }\n     5\t}';
      const result = parseCatOutput(input);
      expect(result.code).toBe('function foo() {\n  if (true) {\n    return;\n  }\n}');
    });

    test('handles empty content lines', () => {
      const input = '     1\tline one\n     2\t\n     3\tline three';
      const result = parseCatOutput(input);
      expect(result.code).toBe('line one\n\nline three');
    });

    test('handles many lines', () => {
      const lines = [];
      for (let i = 1; i <= 50; i++) {
        lines.push(`${String(i).padStart(6)}\tline ${i}`);
      }
      const result = parseCatOutput(lines.join('\n'));
      expect(result.startLine).toBe(1);
      const codeLines = result.code.split('\n');
      expect(codeLines).toHaveLength(50);
      expect(codeLines[0]).toBe('line 1');
      expect(codeLines[49]).toBe('line 50');
    });
  });

  describe('start line detection', () => {
    test('detects start line from first numbered line', () => {
      const input = '     5\tline five\n     6\tline six\n     7\tline seven';
      const result = parseCatOutput(input);
      expect(result.startLine).toBe(5);
    });

    test('detects start line from high number', () => {
      const input = '  1000\tdeep in the file\n  1001\tnext line';
      const result = parseCatOutput(input);
      expect(result.startLine).toBe(1000);
    });

    test('defaults to 1 when no line numbers found', () => {
      const input = 'just plain text\nno line numbers';
      const result = parseCatOutput(input);
      expect(result.startLine).toBe(1);
    });
  });

  describe('trailing empty line removal', () => {
    test('removes trailing empty line', () => {
      const input = '     1\tcontent\n';
      const result = parseCatOutput(input);
      expect(result.code).toBe('content');
    });

    test('removes only the last trailing empty line', () => {
      const input = '     1\tline one\n     2\t\n';
      const result = parseCatOutput(input);
      // Line 2 is empty content, trailing newline after it gets removed
      expect(result.code).toBe('line one\n');
    });

    test('handles output with no trailing newline', () => {
      const input = '     1\tcontent';
      const result = parseCatOutput(input);
      expect(result.code).toBe('content');
    });
  });

  describe('lines without line numbers', () => {
    test('passes through lines without line numbers unchanged', () => {
      const input = 'no number here';
      const result = parseCatOutput(input);
      expect(result.code).toBe('no number here');
    });

    test('passes through mixed content', () => {
      // If there is a line that does not match the pattern, it passes through
      const input = '     1\tnumbered line\nplain line\n     3\tanother numbered';
      const result = parseCatOutput(input);
      expect(result.code).toBe('numbered line\nplain line\nanother numbered');
      expect(result.startLine).toBe(1);
    });
  });

  describe('empty input', () => {
    test('handles empty string', () => {
      const result = parseCatOutput('');
      expect(result.code).toBe('');
      expect(result.startLine).toBe(1);
    });

    test('handles string with only whitespace', () => {
      const result = parseCatOutput('   ');
      expect(result.code).toBe('   ');
      expect(result.startLine).toBe(1);
    });

    test('handles single newline', () => {
      const result = parseCatOutput('\n');
      // Two lines from split: ['', ''], trailing empty removed -> ['']
      expect(result.code).toBe('');
      expect(result.startLine).toBe(1);
    });
  });

  describe('edge cases', () => {
    test('content containing tab characters is preserved', () => {
      const input = '     1\tconst x = {\n     2\t\tnestedProp: true\n     3\t};';
      const result = parseCatOutput(input);
      expect(result.code).toBe('const x = {\n\tnestedProp: true\n};');
    });

    test('content containing arrow character is preserved after separator', () => {
      const input = '     1\tconst arrow = \u2192;';
      const result = parseCatOutput(input);
      expect(result.code).toBe('const arrow = \u2192;');
    });

    test('line number with no leading spaces', () => {
      const input = '1\tcontent';
      const result = parseCatOutput(input);
      expect(result.code).toBe('content');
      expect(result.startLine).toBe(1);
    });
  });
});
