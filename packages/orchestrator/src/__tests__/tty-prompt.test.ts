import { describe, expect, test } from 'bun:test';

import { typeSecretChar } from '../infrastructure/tty-prompt.js';

/** Types `keys` one by one; the answer, or the text so far when unfinished. */
function typeAll(keys: string, multiline = false): { done: string | null } | { buffer: string } {
  let buffer = '';
  for (const char of keys) {
    const typed = typeSecretChar(buffer, char, multiline);
    if ('done' in typed) return typed;
    buffer = typed.buffer;
  }
  return { buffer };
}

describe('secret prompt keys', () => {
  test('a one-line secret ends at Enter, with backspace applied', () => {
    expect(typeAll('sk-abx\u007fc\r')).toEqual({ done: 'sk-abc' });
    expect(typeAll('sk-abc\n')).toEqual({ done: 'sk-abc' });
  });

  test('Ctrl-C and Ctrl-D give up', () => {
    expect(typeAll('sk-\u0003')).toEqual({ done: null });
    expect(typeAll('sk-\u0004')).toEqual({ done: null });
  });

  test('a pasted PEM ends only at the Enter after its END line', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\rMIIE\r-----END RSA PRIVATE KEY-----\r';
    expect(typeAll(pem, true)).toEqual({
      done: '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
    });
    expect(typeAll('-----BEGIN RSA PRIVATE KEY-----\rMIIE\r', true)).toEqual({
      buffer: '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n',
    });
  });
});
