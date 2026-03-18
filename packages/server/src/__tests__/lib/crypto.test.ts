import { describe, test, expect, beforeAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point DATA_DIR to a temp directory to isolate side-effects
const testDir = mkdtempSync(join(tmpdir(), 'funny-crypto-test-'));
process.env.FUNNY_DATA_DIR = testDir;

// Import AFTER setting env so data-dir.ts picks up the temp directory
const { encrypt, decrypt } = await import('../../lib/crypto.js');

// ── encrypt / decrypt round-trip ─────────────────────────────────

describe('encrypt', () => {
  test('returns a string in format iv:authTag:ciphertext', () => {
    const result = encrypt('hello');
    const parts = result.split(':');
    expect(parts.length).toBe(3);
    // All parts should be hex strings
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
  });

  test('produces different ciphertexts for the same plaintext', () => {
    const a = encrypt('same input');
    const b = encrypt('same input');
    expect(a).not.toBe(b);
  });
});

describe('decrypt', () => {
  test('round-trip: decrypt(encrypt(x)) === x', () => {
    const plaintext = 'hello world';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  test('handles empty string round-trip', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  test('handles long strings (10,000+ chars)', () => {
    const long = 'x'.repeat(10_000);
    expect(decrypt(encrypt(long))).toBe(long);
  });

  test('handles unicode and emoji', () => {
    const unicode = '你好世界 🎉🚀 café résumé';
    expect(decrypt(encrypt(unicode))).toBe(unicode);
  });

  test('returns null for malformed input (no colons)', () => {
    expect(decrypt('notvalidhex')).toBeNull();
  });

  test('returns null for input with only 2 parts', () => {
    expect(decrypt('aa:bb')).toBeNull();
  });

  test('returns null for tampered ciphertext', () => {
    const encrypted = encrypt('secret');
    const parts = encrypted.split(':');
    // Flip a character in the ciphertext
    const tampered = parts[2].replace(/[0-9a-f]/, (c) => (c === '0' ? '1' : '0'));
    expect(decrypt(`${parts[0]}:${parts[1]}:${tampered}`)).toBeNull();
  });

  test('returns null for tampered auth tag', () => {
    const encrypted = encrypt('secret');
    const parts = encrypted.split(':');
    // Flip a character in the auth tag
    const tampered = parts[1].replace(/[0-9a-f]/, (c) => (c === '0' ? '1' : '0'));
    expect(decrypt(`${parts[0]}:${tampered}:${parts[2]}`)).toBeNull();
  });

  test('returns null for completely random string', () => {
    expect(decrypt('zzzz:yyyy:xxxx')).toBeNull();
  });
});
