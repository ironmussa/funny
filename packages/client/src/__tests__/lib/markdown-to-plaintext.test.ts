import { describe, test, expect } from 'vitest';

import { analyzeMarkdown } from '@/lib/markdown-to-plaintext';

describe('analyzeMarkdown', () => {
  test('strips inline markdown from plain lines', () => {
    const result = analyzeMarkdown('**bold** and *italic* with `code`');

    expect(result.plainText).toBe('bold and italic with code');
    expect(result.codeBlockCount).toBe(0);
    expect(result.codeBlockLines).toBe(0);
  });

  test('tracks fenced code blocks separately from prose', () => {
    const markdown = ['Intro line', '```ts', 'const x = 1;', '```', 'After code'].join('\n');
    const result = analyzeMarkdown(markdown);

    expect(result.plainText).toBe('Intro line\nAfter code');
    expect(result.codeBlockCount).toBe(1);
    expect(result.codeBlockLines).toBe(1);
    expect(result.extraHeightPx).toBeGreaterThan(0);
  });

  test('adds extra height for headings, rules, images, and tables', () => {
    const markdown = [
      '# Title',
      '---',
      '![alt](img.png)',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n');

    const result = analyzeMarkdown(markdown);

    expect(result.plainText).toContain('Title');
    expect(result.extraHeightPx).toBeGreaterThan(200);
  });

  test('returns cached result for identical input', () => {
    const first = analyzeMarkdown('same input');
    const second = analyzeMarkdown('same input');

    expect(second).toBe(first);
  });

  test('handles blockquotes and strips inline formatting inside them', () => {
    const result = analyzeMarkdown('> **Important** note');

    expect(result.plainText).toBe('Important note');
    expect(result.extraHeightPx).toBeGreaterThan(0);
  });
});
