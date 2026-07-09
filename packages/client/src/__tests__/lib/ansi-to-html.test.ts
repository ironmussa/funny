import { describe, test, expect } from 'vitest';

import { createAnsiConverter, stripAnsi } from '@/lib/ansi-to-html';

describe('createAnsiConverter', () => {
  test('forces escapeXML so < is escaped', () => {
    const converter = createAnsiConverter();
    const out = converter.toHtml('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  test('escapeXML survives explicit opts spread', () => {
    // Security M6 regression guard: even if a caller tries to override
    // escapeXML (which TypeScript now blocks at the type level) the helper
    // must still produce safe output.
    const converter = createAnsiConverter({
      fg: '#fff',
      bg: 'transparent',
      escapeXML: false,
    });
    const out = converter.toHtml('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  test('still handles ANSI colour codes', () => {
    const converter = createAnsiConverter();
    const out = converter.toHtml('\u001b[31mhello\u001b[0m');
    expect(out).toContain('hello');
    expect(out.toLowerCase()).toMatch(/style=.*color/);
  });

  test('strips ANSI sequences for plain-text previews', () => {
    expect(stripAnsi('\u001b[2m2026-07-09\u001b[0m \u001b[31mERROR\u001b[0m')).toBe(
      '2026-07-09 ERROR',
    );
  });
});
