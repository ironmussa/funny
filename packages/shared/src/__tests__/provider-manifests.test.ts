import { describe, expect, test } from 'bun:test';

import { ACP_MANIFESTS, getManifest } from '../provider-manifests.js';

describe('getManifest', () => {
  test('finds a bundled ACP manifest by its provider id', () => {
    expect(getManifest('gemini')).toBe(ACP_MANIFESTS.gemini);
  });

  test('returns undefined for an unknown provider id', () => {
    expect(getManifest('no-such-provider')).toBeUndefined();
  });

  test('does not answer with an inherited object member', () => {
    for (const id of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(getManifest(id)).toBeUndefined();
    }
  });
});
