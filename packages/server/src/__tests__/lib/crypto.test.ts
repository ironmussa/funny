import { afterAll, describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Point DATA_DIR to a temp directory to isolate side-effects
const testDir = mkdtempSync(join(tmpdir(), 'funny-crypto-test-'));
process.env.FUNNY_DATA_DIR = testDir;
afterAll(() => rmSync(testDir, { recursive: true, force: true }));

// Import AFTER setting env so data-dir.ts picks up the temp directory
const { encrypt, decrypt, rotateKey, isEncryptedWithActiveKey } =
  await import('../../lib/crypto.js');

// ── encrypt / decrypt round-trip ─────────────────────────────────

describe('encrypt', () => {
  test('returns a v1:keyId:iv:authTag:ciphertext string', () => {
    const result = encrypt('hello');
    const parts = result.split(':');
    expect(parts.length).toBe(5);
    expect(parts[0]).toBe('v1');
    // keyId opaque, remaining three must be hex
    for (const part of parts.slice(2)) {
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
    // Flip a character in the ciphertext (part index 4 in v1 format)
    const tampered = parts[4].replace(/[0-9a-f]/, (c) => (c === '0' ? '1' : '0'));
    expect(decrypt(`${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}:${tampered}`)).toBeNull();
  });

  test('returns null for tampered auth tag', () => {
    const encrypted = encrypt('secret');
    const parts = encrypted.split(':');
    // Flip a character in the auth tag (part index 3 in v1 format)
    const tampered = parts[3].replace(/[0-9a-f]/, (c) => (c === '0' ? '1' : '0'));
    expect(decrypt(`${parts[0]}:${parts[1]}:${parts[2]}:${tampered}:${parts[4]}`)).toBeNull();
  });

  test('returns null for completely random string', () => {
    expect(decrypt('zzzz:yyyy:xxxx')).toBeNull();
  });
});

// ── key rotation ─────────────────────────────────────────────────

describe('rotateKey', () => {
  test('old ciphertext still decrypts after a rotation', () => {
    const before = encrypt('pre-rotation');
    const newKeyId = rotateKey();
    expect(newKeyId).toMatch(/^k/);

    expect(decrypt(before)).toBe('pre-rotation');

    const after = encrypt('post-rotation');
    expect(decrypt(after)).toBe('post-rotation');

    // New writes use the new key, old ciphertext uses the old key
    expect(isEncryptedWithActiveKey(before)).toBe(false);
    expect(isEncryptedWithActiveKey(after)).toBe(true);
  });
});
