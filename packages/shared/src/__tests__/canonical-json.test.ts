import { describe, expect, test } from 'bun:test';

import { canonicalJson } from '../lib/canonical-json';
import { canonicalJson as connectorCanonicalJson } from '../remote-connector-protocol';

describe('canonicalJson', () => {
  test('sorts object keys at every depth and keeps array order', () => {
    const value = { b: 1, a: { d: [{ z: 1, y: 2 }, 3], c: 'x' } };
    expect(canonicalJson(value)).toBe('{"a":{"c":"x","d":[{"y":2,"z":1},3]},"b":1}');
    expect(connectorCanonicalJson(value)).toBe('{"a":{"c":"x","d":[{"y":2,"z":1},3]},"b":1}');
  });

  test('passes leaves through to JSON.stringify unchanged', () => {
    expect(canonicalJson('text')).toBe('"text"');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBeUndefined();
    expect(canonicalJson([undefined, () => 1])).toBe('[null,null]');
    expect(canonicalJson({ keep: 1, drop: undefined })).toBe('{"keep":1}');
  });

  test('rebuilds non-plain objects from their own entries', () => {
    // A Date has no own enumerable entries, so its copy (and its toJSON) is gone.
    expect(canonicalJson({ at: new Date(0) })).toBe('{"at":{}}');
    expect(connectorCanonicalJson({ at: new Date(0) })).toBe('{"at":{}}');
  });

  test('the two encoders differ only in how they order keys', () => {
    // localeCompare puts lowercase before uppercase; code-unit order does the opposite.
    expect(canonicalJson({ b: 1, B: 2 })).toBe('{"b":1,"B":2}');
    expect(connectorCanonicalJson({ b: 1, B: 2 })).toBe('{"B":2,"b":1}');
  });
});
