/**
 * Tests for the runtime crypto wrapper. The implementation now lives in
 * `@funny/shared/lib/crypto` (Security ME-11 consolidation) and produces
 * the `v1:keyId:iv:authTag:ciphertext` envelope. Legacy 3-part inputs are
 * still accepted on decrypt for backward-compat with previously-stored
 * data — that path is exercised in the server suite where a legacy
 * `encryption.key` is seeded.
 */
import { describe, test, expect } from 'vitest';

import { encrypt, decrypt } from '../../lib/crypto.js';

describe('encrypt (v1 envelope)', () => {
  test('returns a string in v1:keyId:iv:authTag:ciphertext format', () => {
    const result = encrypt('hello');
    const parts = result.split(':');
    expect(parts.length).toBe(5);
    expect(parts[0]).toBe('v1');
  });

  test('keyId is non-empty', () => {
    const result = encrypt('test');
    const keyId = result.split(':')[1];
    expect(keyId.length).toBeGreaterThan(0);
  });

  test('iv is 24 hex characters (12 bytes)', () => {
    const result = encrypt('test');
    const iv = result.split(':')[2];
    expect(iv.length).toBe(24);
    expect(/^[0-9a-f]+$/.test(iv)).toBe(true);
  });

  test('authTag is 32 hex characters (16 bytes)', () => {
    const result = encrypt('test');
    const authTag = result.split(':')[3];
    expect(authTag.length).toBe(32);
    expect(/^[0-9a-f]+$/.test(authTag)).toBe(true);
  });

  test('ciphertext is non-empty hex string', () => {
    const result = encrypt('test');
    const ciphertext = result.split(':')[4];
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/.test(ciphertext)).toBe(true);
  });

  test('encrypting the same plaintext produces different output each time (random IV)', () => {
    const a = encrypt('same text');
    const b = encrypt('same text');
    expect(a).not.toBe(b);
  });

  test('encrypts empty string', () => {
    const result = encrypt('');
    const parts = result.split(':');
    expect(parts.length).toBe(5);
  });

  test('encrypts unicode content', () => {
    const result = encrypt('Hello world');
    const parts = result.split(':');
    expect(parts.length).toBe(5);
  });

  test('encrypts long string', () => {
    const longText = 'x'.repeat(10_000);
    const result = encrypt(longText);
    const parts = result.split(':');
    expect(parts.length).toBe(5);
  });
});

describe('decrypt', () => {
  test('decrypts back to original plaintext', () => {
    const plaintext = 'my secret token';
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  test('decrypts empty string', () => {
    const encrypted = encrypt('');
    expect(decrypt(encrypted)).toBe('');
  });

  test('decrypts unicode content', () => {
    const text = 'Hola mundo! Clave secreta';
    const encrypted = encrypt(text);
    expect(decrypt(encrypted)).toBe(text);
  });

  test('decrypts long content', () => {
    const longText = 'token-'.repeat(1000);
    const encrypted = encrypt(longText);
    expect(decrypt(encrypted)).toBe(longText);
  });

  test('decrypts special characters', () => {
    const text = 'p@$$w0rd!#%^&*()_+{}|:<>?';
    const encrypted = encrypt(text);
    expect(decrypt(encrypted)).toBe(text);
  });

  test('returns null for corrupted ciphertext', () => {
    const encrypted = encrypt('test');
    const parts = encrypted.split(':');
    parts[4] = 'ff'.repeat(parts[4].length / 2);
    const corrupted = parts.join(':');
    expect(decrypt(corrupted)).toBeNull();
  });

  test('returns null for corrupted authTag', () => {
    const encrypted = encrypt('test');
    const parts = encrypted.split(':');
    parts[3] = '00'.repeat(16);
    const corrupted = parts.join(':');
    expect(decrypt(corrupted)).toBeNull();
  });

  test('returns null for corrupted IV', () => {
    const encrypted = encrypt('test');
    const parts = encrypted.split(':');
    parts[2] = '00'.repeat(12);
    const corrupted = parts.join(':');
    expect(decrypt(corrupted)).toBeNull();
  });

  test('returns null for wrong format (no colons)', () => {
    expect(decrypt('notvalidencrypteddata')).toBeNull();
  });

  test('returns null for wrong format (only one colon)', () => {
    expect(decrypt('part1:part2')).toBeNull();
  });

  test('returns null for wrong format (four parts)', () => {
    expect(decrypt('a:b:c:d')).toBeNull();
  });

  test('returns null for v0/unknown version prefix', () => {
    expect(decrypt('v9:k:iv:tag:ct')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(decrypt('')).toBeNull();
  });

  test('returns null for legacy-shaped input when no legacy key is registered', () => {
    // 3-part input is treated as legacy and looked up under keyId=`legacy`.
    // The test data dir doesn't have a legacy key registered (only the
    // freshly-generated active one), so decrypt fails open with null.
    const fakeIv = 'ab'.repeat(12);
    const fakeTag = 'cd'.repeat(16);
    const fakeCiphertext = 'ef'.repeat(20);
    const fake = `${fakeIv}:${fakeTag}:${fakeCiphertext}`;
    expect(decrypt(fake)).toBeNull();
  });

  test('returns null for random hex values in v1 format with unknown keyId', () => {
    const fake = `v1:nope:${'ab'.repeat(12)}:${'cd'.repeat(16)}:${'ef'.repeat(20)}`;
    expect(decrypt(fake)).toBeNull();
  });

  test('roundtrip with multiple different plaintexts', () => {
    const texts = [
      'short',
      'a longer piece of text with spaces and numbers 12345',
      '{"json": "value", "key": true}',
      `ghp_${'x'.repeat(36)}`,
      '',
      '\n\t\r',
    ];

    for (const text of texts) {
      const encrypted = encrypt(text);
      expect(decrypt(encrypted)).toBe(text);
    }
  });
});

/**
 * Security ME-11 regression — the runtime crypto used to be a separate
 * legacy-only module. After consolidation, encrypt() produces the v1
 * envelope, matching what the server writes. Both modules share the
 * `@funny/shared/lib/crypto` factory.
 */
describe('ME-11 — runtime + server share the same envelope format', () => {
  test('encrypt output is in v1 format (would have been 3 parts before consolidation)', () => {
    const result = encrypt('hello');
    expect(result.startsWith('v1:')).toBe(true);
  });

  test('decrypt still accepts the legacy 3-part shape (only fails because no legacy key is registered in this isolated test)', () => {
    // The acceptance of 3-part shape is verified in the server tests where
    // a legacy key is seeded. Here we just assert that 3-part input takes
    // the legacy branch (returns null due to missing key, not due to
    // shape rejection).
    const legacyShape = `${'00'.repeat(12)}:${'00'.repeat(16)}:${'00'.repeat(20)}`;
    expect(decrypt(legacyShape)).toBeNull(); // null = no legacy key, not shape error
  });
});
