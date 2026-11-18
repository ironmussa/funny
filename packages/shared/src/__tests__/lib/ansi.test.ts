import { describe, expect, test } from 'bun:test';

import { hasAnsi, stripAnsi } from '../../lib/ansi.js';

const ESC = '\u001b';

describe('stripAnsi', () => {
  test('drops colors, cursor moves, titles and links', () => {
    expect(stripAnsi(`${ESC}[31m1 failed${ESC}[39m`)).toBe('1 failed');
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gdone`)).toBe('done');
    expect(stripAnsi(`${ESC}[?25lhidden cursor${ESC}[?25h`)).toBe('hidden cursor');
    expect(stripAnsi(`${ESC}]0;title\u0007text`)).toBe('text');
    expect(stripAnsi(`${ESC}]8;;https://x.dev${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link');
  });

  test('leaves plain text alone', () => {
    expect(stripAnsi('a [31m b')).toBe('a [31m b');
  });
});

describe('hasAnsi', () => {
  test('tells colored output from plain text', () => {
    expect(hasAnsi(`${ESC}[32mok${ESC}[0m`)).toBe(true);
    expect(hasAnsi('ok')).toBe(false);
  });
});
