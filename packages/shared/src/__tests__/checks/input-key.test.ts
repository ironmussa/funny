import { describe, expect, test } from 'bun:test';

import { checkInputKey } from '../../checks/input-key';

describe('checkInputKey', () => {
  test('ignores field order, empty values and unknown fields', () => {
    const key = checkInputKey({ kind: 'test', scope: ['src'] });
    expect(checkInputKey({ scope: ['src'], kind: 'test' })).toBe(key);
    expect(checkInputKey({ kind: 'test', scope: ['src'], filter: '', background: false })).toBe(
      key,
    );
    expect(checkInputKey({ kind: 'test', scope: ['src'], extra: 1 })).toBe(key);
    expect(checkInputKey({ kind: 'test' })).toBe(checkInputKey({ kind: 'test', scope: [] }));
  });

  test('differs when the run differs', () => {
    const keys = new Set(
      [
        { kind: 'test' },
        { kind: 'lint' },
        { kind: 'test', scope: ['a'] },
        { kind: 'test', filter: 'x' },
        { kind: 'test', background: true },
        { kind: 'test', command: 'npx vitest run' },
      ].map(checkInputKey),
    );
    expect(keys.size).toBe(6);
  });
});
