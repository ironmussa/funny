import { describe, test, expect } from 'bun:test';

import { encrypt, decrypt } from '../../lib/crypto.js';

describe('encrypt', () => {
  test('returns a string in iv:authTag:ciphertext format', () => {
    const result = encrypt('hello');
    const parts = result.split(':');
    expect(parts.length).toBe(3);
  });

  test('iv is 24 hex characters (12 bytes)', () => {
    const result = encrypt('test');
    const iv = result.split(':')[0];
    expect(iv.length).toBe(24);
    expect(/^[0-9a-f]+$/.test(iv)).toBe(true);
  });

  test('authTag is 32 hex characters (16 bytes)', () => {
    const result = encrypt('test');
    const authTag = result.split(':')[1];
    expect(authTag.length).toBe(32);
    expect(/^[0-9a-f]+$/.test(authTag)).toBe(true);
  });

  test('ciphertext is non-empty hex string', () => {
    const result = encrypt('test');
    const ciphertext = result.split(':')[2];
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
    expect(parts.length).toBe(3);
  });

  test('encrypts unicode content', () => {
    const result = encrypt('Hello world');
    const parts = result.split(':');
    expect(parts.length).toBe(3);
  });

  test('encrypts long string', () => {
    const longText = 'x'.repeat(10_000);
    const result = encrypt(longText);
    const parts = result.split(':');
    expect(parts.length).toBe(3);
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
    // Corrupt the ciphertext portion
    parts[2] = 'ff'.repeat(parts[2].length / 2);
    const corrupted = parts.join(':');
    expect(decrypt(corrupted)).toBeNull();
  });

  test('returns null for corrupted authTag', () => {
    const encrypted = encrypt('test');
    const parts = encrypted.split(':');
    // Corrupt the auth tag
    parts[1] = '00'.repeat(16);
    const corrupted = parts.join(':');
    expect(decrypt(corrupted)).toBeNull();
  });

  test('returns null for corrupted IV', () => {
    const encrypted = encrypt('test');
    const parts = encrypted.split(':');
    // Corrupt the IV
    parts[0] = '00'.repeat(12);
    const corrupted = parts.join(':');
    // This may or may not return null depending on whether the tag check fails
    // but the decrypted text should not match original
    const result = decrypt(corrupted);
    // With GCM, changing IV should cause auth failure
    expect(result).toBeNull();
  });

  test('returns null for wrong format (no colons)', () => {
    expect(decrypt('notvalidencrypteddata')).toBeNull();
  });

  test('returns null for wrong format (only one colon)', () => {
    expect(decrypt('part1:part2')).toBeNull();
  });

  test('returns null for wrong format (too many colons)', () => {
    expect(decrypt('a:b:c:d')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(decrypt('')).toBeNull();
  });

  test('returns null for completely random hex values in correct format', () => {
    const fakeIv = 'ab'.repeat(12);
    const fakeTag = 'cd'.repeat(16);
    const fakeCiphertext = 'ef'.repeat(20);
    const fake = `${fakeIv}:${fakeTag}:${fakeCiphertext}`;
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
