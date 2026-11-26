import { describe, expect, test } from 'bun:test';

import { definedJsonFields, type JsonObject } from '../json.js';

describe('definedJsonFields', () => {
  test('leaves out undefined fields, as JSON.stringify does', () => {
    const fields = { sha: undefined, reason: 'ok', count: 0, empty: null, flag: false };
    const defined: JsonObject = definedJsonFields(fields);
    expect(defined).toEqual({ reason: 'ok', count: 0, empty: null, flag: false });
    expect(Object.hasOwn(defined, 'sha')).toBe(false);
    expect(JSON.parse(JSON.stringify(fields))).toEqual(defined);
  });

  test('keeps nested JSON as it is', () => {
    expect(definedJsonFields({ checks: [{ name: 'ci' }], meta: { a: 1 } })).toEqual({
      checks: [{ name: 'ci' }],
      meta: { a: 1 },
    });
  });
});
