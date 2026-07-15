import { describe, expect, test } from 'vitest';

import { splitSatteriMarkdownSegments } from '@/lib/satteri-markdown-segments';

describe('splitSatteriMarkdownSegments', () => {
  test('keeps prose static while preserving visualizer, nested markdown, and images as islands', () => {
    const segments = splitSatteriMarkdownSegments(
      [
        'before',
        '',
        '```mermaid',
        'graph TD',
        '```',
        '',
        '```markdown',
        '# nested',
        '```',
        '',
        '![shot](/tmp/shot.png "Screenshot")',
        '',
        'after',
      ].join('\n'),
      (language) => language === 'mermaid',
    );

    expect(segments).toEqual([
      { type: 'html', markdown: 'before\n\n' },
      { type: 'visualizer', language: 'mermaid', source: 'graph TD\n' },
      { type: 'html', markdown: '\n' },
      { type: 'nested-markdown', markdown: '# nested\n' },
      { type: 'image', alt: 'shot', src: '/tmp/shot.png', title: 'Screenshot' },
      { type: 'html', markdown: '\nafter' },
    ]);
  });

  test('passes ordinary fenced code through the static Sätteri path', () => {
    const segments = splitSatteriMarkdownSegments('```ts\nconst value = 1;\n```', () => false);
    expect(segments).toEqual([{ type: 'html', markdown: '```ts\nconst value = 1;\n```' }]);
  });
});
