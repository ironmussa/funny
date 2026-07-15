import { describe, expect, test, vi } from 'vitest';

import {
  ByteLruCache,
  createSafeMarkdownRenderer,
  renderMarkdownToSafeHtml,
  sanitizeSatteriHtml,
} from '@/lib/satteri-markdown';

describe('satteri markdown sanitization', () => {
  test('strips executable HTML, event attributes, and javascript URLs', () => {
    const html = sanitizeSatteriHtml(
      '<script>alert(1)</script><iframe src="https://evil.example"></iframe><img src=x onerror="alert(1)"><a href="javascript:alert(1)" onclick="alert(1)">bad</a>',
    );

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
  });

  test('keeps benign GitHub-style HTML and task-list attributes', () => {
    const html = sanitizeSatteriHtml(
      '<details open><summary>More</summary><br><input type="checkbox" checked disabled></details>',
    );

    expect(html).toContain('<details open="">');
    expect(html).toContain('<summary>More</summary>');
    expect(html).toContain('<br>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain('disabled=""');
  });

  test('keeps relative repository paths and approved web URLs', () => {
    const html = sanitizeSatteriHtml(
      '<a href="packages/client/src/lib/editor-utils.ts">local</a><a href="https://example.com/path">web</a>',
    );

    expect(html).toContain('href="packages/client/src/lib/editor-utils.ts"');
    expect(html).toContain('href="https://example.com/path"');
  });
});

describe('ByteLruCache', () => {
  test('moves cache hits to the newest position and evicts by retained bytes', () => {
    const cache = new ByteLruCache(12);
    cache.set('a', '1111'); // 5 bytes
    cache.set('b', '2222'); // 5 bytes
    expect(cache.get('a')).toBe('1111'); // b becomes LRU

    cache.set('c', '3333'); // evicts b to stay under 12 bytes
    expect(cache.get('a')).toBe('1111');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('3333');
    expect(cache.bytes).toBeLessThanOrEqual(12);
  });

  test('does not retain a single entry larger than its byte cap', () => {
    const cache = new ByteLruCache(4);
    cache.set('a', 'too large');
    expect(cache.size).toBe(0);
  });
});

describe('createSafeMarkdownRenderer', () => {
  test('compiles and sanitizes once for repeated content', async () => {
    const compile = vi.fn(async (content: string) => `<p>${content}</p>`);
    const sanitizer = vi.fn((html: string) => html.replace('unsafe', 'safe'));
    const render = createSafeMarkdownRenderer({ compile, sanitizer });

    await expect(render('unsafe')).resolves.toBe('<p>safe</p>');
    await expect(render('unsafe')).resolves.toBe('<p>safe</p>');

    expect(compile).toHaveBeenCalledTimes(1);
    expect(sanitizer).toHaveBeenCalledTimes(1);
  });
});

describe('renderMarkdownToSafeHtml', () => {
  test('keeps GFM tables, task lists, and fenced-code language classes', async () => {
    const html = await renderMarkdownToSafeHtml(
      [
        '| name | value |',
        '| --- | --- |',
        '| safe | yes |',
        '',
        '- [x] done',
        '- [ ] pending',
        '',
        '```ts',
        'const value = 1;',
        '```',
      ].join('\n'),
    );

    expect(html).toContain('<table>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain('class="language-ts"');
  });
});
