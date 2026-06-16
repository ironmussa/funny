/**
 * Unit tests for `parseByteRange` — the HTTP `Range:` header parser behind the
 * 206 Partial Content path of `/api/files/raw`.
 *
 * NOTE: the actual byte-serving regression (a bounded mid-file range must return
 * EXACTLY the requested bytes, not stream to EOF) cannot be unit-tested in this
 * vitest/Node harness because `Bun.file()` is undefined here and the bug only
 * manifests when `Bun.serve` streams a `BunFile.slice()` body. That fix
 * (materializing bounded ranges via `arrayBuffer()` in `streamRawFile`) was
 * verified live against the running runtime: `bytes=100000-100099` → a 100-byte
 * 206 body matching the source slice, where before it returned the whole tail of
 * the file under a Content-Range claiming 100 bytes. These tests guard the range
 * math that feeds that path.
 */

import { describe, test, expect } from 'vitest';

import { parseByteRange } from '../../routes/files.js';

const SIZE = 1000;

describe('parseByteRange', () => {
  test('returns null when there is no Range header', () => {
    expect(parseByteRange(undefined, SIZE)).toBeNull();
  });

  test('parses a bounded start-end range (inclusive)', () => {
    expect(parseByteRange('bytes=100-199', SIZE)).toEqual({ start: 100, end: 199 });
  });

  test('parses an open-ended start- range to EOF', () => {
    expect(parseByteRange('bytes=0-', SIZE)).toEqual({ start: 0, end: SIZE - 1 });
    expect(parseByteRange('bytes=500-', SIZE)).toEqual({ start: 500, end: SIZE - 1 });
  });

  test('parses a -suffix range as the last N bytes', () => {
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
  });

  test('clamps a -suffix larger than the file to the whole file', () => {
    expect(parseByteRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  test('clamps an end past EOF to the last byte', () => {
    expect(parseByteRange('bytes=900-100000', SIZE)).toEqual({ start: 900, end: 999 });
  });

  test('tolerates surrounding whitespace', () => {
    expect(parseByteRange('  bytes=0-9  ', SIZE)).toEqual({ start: 0, end: 9 });
  });

  test('returns null for an unsatisfiable start beyond EOF', () => {
    expect(parseByteRange('bytes=1000-1100', SIZE)).toBeNull();
    expect(parseByteRange('bytes=2000-', SIZE)).toBeNull();
  });

  test('returns null for a zero-length / empty file', () => {
    expect(parseByteRange('bytes=0-10', 0)).toBeNull();
  });

  test('returns null for an empty or malformed range', () => {
    expect(parseByteRange('bytes=-', SIZE)).toBeNull();
    expect(parseByteRange('bytes=abc-def', SIZE)).toBeNull();
    expect(parseByteRange('items=0-10', SIZE)).toBeNull();
    expect(parseByteRange('bytes=-0', SIZE)).toBeNull(); // zero-length suffix
  });

  test('returns null for a multi-range header (unsupported)', () => {
    expect(parseByteRange('bytes=0-10,20-30', SIZE)).toBeNull();
  });
});
