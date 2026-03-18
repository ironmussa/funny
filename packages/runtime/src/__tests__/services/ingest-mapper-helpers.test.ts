import { describe, test, expect } from 'vitest';

import { decodeUnicodeEscapes, parseOwnerRepo } from '../../services/ingest-mapper.js';

// ── decodeUnicodeEscapes ─────────────────────────────────────────

describe('decodeUnicodeEscapes', () => {
  test('decodes basic Unicode escape sequences', () => {
    expect(decodeUnicodeEscapes('Hello \\u0048\\u0065\\u006C\\u006C\\u006F')).toBe('Hello Hello');
  });

  test('decodes CJK characters', () => {
    expect(decodeUnicodeEscapes('\\u4F60\\u597D')).toBe('你好');
  });

  test('returns string as-is when no escapes', () => {
    expect(decodeUnicodeEscapes('plain text')).toBe('plain text');
  });

  test('handles empty string', () => {
    expect(decodeUnicodeEscapes('')).toBe('');
  });

  test('handles mixed content', () => {
    expect(decodeUnicodeEscapes('Name: \\u0041lice')).toBe('Name: Alice');
  });

  test('handles emoji-range codepoints', () => {
    // \\u2764 = ❤
    expect(decodeUnicodeEscapes('Love \\u2764')).toBe('Love ❤');
  });

  test('is case-insensitive for hex digits', () => {
    expect(decodeUnicodeEscapes('\\u004a\\u004A')).toBe('JJ');
  });

  test('does not decode incomplete sequences', () => {
    expect(decodeUnicodeEscapes('\\u00')).toBe('\\u00');
  });
});

// ── parseOwnerRepo ───────────────────────────────────────────────

describe('parseOwnerRepo', () => {
  test('extracts from HTTPS URL', () => {
    expect(parseOwnerRepo('https://github.com/acme/backend')).toBe('acme/backend');
  });

  test('extracts from HTTPS URL with .git suffix', () => {
    expect(parseOwnerRepo('https://github.com/acme/backend.git')).toBe('acme/backend');
  });

  test('extracts from SSH URL', () => {
    expect(parseOwnerRepo('git@github.com:acme/backend')).toBe('acme/backend');
  });

  test('extracts from SSH URL with .git suffix', () => {
    expect(parseOwnerRepo('git@github.com:acme/backend.git')).toBe('acme/backend');
  });

  test('returns null for non-GitHub URL', () => {
    expect(parseOwnerRepo('https://gitlab.com/acme/backend')).toBeNull();
  });

  test('returns null for invalid URL', () => {
    expect(parseOwnerRepo('not-a-url')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseOwnerRepo('')).toBeNull();
  });

  test('handles org with hyphens and underscores', () => {
    expect(parseOwnerRepo('https://github.com/my-org_123/my-repo')).toBe('my-org_123/my-repo');
  });

  test('returns null for repo with dots in name (non-git suffix)', () => {
    expect(parseOwnerRepo('https://github.com/acme/my.repo.name')).toBeNull();
  });
});
