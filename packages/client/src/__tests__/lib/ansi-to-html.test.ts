import { describe, test, expect } from 'vitest';

import { createAnsiConverter } from '@/lib/ansi-to-html';

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
});
