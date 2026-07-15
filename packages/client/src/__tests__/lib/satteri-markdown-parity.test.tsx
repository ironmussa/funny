import { describe, expect, test } from 'vitest';

import { renderMarkdownToSafeHtml } from '@/lib/satteri-markdown';

function semanticShape(html: string) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  return {
    anchors: Array.from(document.querySelectorAll('a')).map((link) => link.getAttribute('href')),
    codeLanguages: Array.from(document.querySelectorAll('pre > code')).map(
      (code) => code.className,
    ),
    details: document.querySelectorAll('details').length,
    headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(
      (heading) => heading.textContent,
    ),
    images: document.querySelectorAll('img').length,
    tables: document.querySelectorAll('table').length,
    taskCheckboxes: Array.from(document.querySelectorAll('input[type="checkbox"]')).map((input) =>
      input.hasAttribute('checked'),
    ),
  };
}

describe('Sätteri semantic markdown features', () => {
  test('renders the supported real-message feature surface', async () => {
    const cases = [
      {
        markdown: '# Heading\n\nA [safe link](https://example.com).',
        expected: {
          anchors: ['https://example.com'],
          codeLanguages: [],
          details: 0,
          headings: ['Heading'],
          images: 0,
          tables: 0,
          taskCheckboxes: [],
        },
      },
      {
        markdown:
          '| name | done |\n| --- | --- |\n| migration | yes |\n\n- [x] shipped\n- [ ] rollout',
        expected: {
          anchors: [],
          codeLanguages: [],
          details: 0,
          headings: [],
          images: 0,
          tables: 1,
          taskCheckboxes: [true, false],
        },
      },
      {
        markdown: '```ts\nconst value = 1;\n```\n\n![diagram](/tmp/diagram.png)',
        expected: {
          anchors: [],
          codeLanguages: ['language-ts'],
          details: 0,
          headings: [],
          images: 1,
          tables: 0,
          taskCheckboxes: [],
        },
      },
      {
        markdown: '<details open><summary>Walkthrough</summary><br>Safe HTML</details>',
        expected: {
          anchors: [],
          codeLanguages: [],
          details: 1,
          headings: [],
          images: 0,
          tables: 0,
          taskCheckboxes: [],
        },
      },
    ];

    for (const { markdown, expected } of cases) {
      expect(semanticShape(await renderMarkdownToSafeHtml(markdown))).toEqual(expected);
    }
  });
});
