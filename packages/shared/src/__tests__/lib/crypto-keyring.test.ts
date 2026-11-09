/**
 * Keyring sources for `createCrypto`: the default files in the data dir
 * (including the legacy single-key file) and a read-only source for hosts
 * without a filesystem.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCrypto,
  fileKeyringSource,
  readOnlyKeyringSource,
  type SerializedKeyring,
} from '../../lib/crypto.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'funny-keyring-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeOwnerOnly(name: string, content: string) {
  writeFileSync(join(dir, name), content, { mode: 0o600 });
}

describe('fileKeyringSource', () => {
  test('first use generates an owner-only keys file that a restart reuses', () => {
    const first = createCrypto({ dataDir: dir });
    const ciphertext = first.encrypt('secret');
    const path = join(dir, 'encryption.keys.json');
    expect(existsSync(path)).toBe(true);

    const restarted = createCrypto({ dataDir: dir });
    expect(restarted.decrypt(ciphertext)).toBe('secret');
  });

  test('save replaces the keyring through a rename and leaves no temp file', () => {
    const source = fileKeyringSource(dir);
    source.save({ active: 'k1', keys: { k1: KEY_A } });
    source.save({ active: 'k2', keys: { k1: KEY_A, k2: KEY_B } });
    expect(readdirSync(dir)).toEqual(['encryption.keys.json']);
    const path = join(dir, 'encryption.keys.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(source.load()).toEqual({ active: 'k2', keys: { k1: KEY_A, k2: KEY_B } });
  });

  test('mounts the legacy key as keyId "legacy" without rewriting it', () => {
    writeOwnerOnly('encryption.key', KEY_A);
    const keyring = fileKeyringSource(dir).load();
    expect(keyring).toEqual({ active: 'legacy', keys: { legacy: KEY_A } });

    const crypto = createCrypto({ dataDir: dir });
    expect(crypto.encrypt('x').split(':')[1]).toBe('legacy');
    expect(existsSync(join(dir, 'encryption.keys.json'))).toBe(false);
  });

  test('merges the legacy key into an existing keys file', () => {
    writeOwnerOnly('encryption.key', KEY_A);
    writeOwnerOnly('encryption.keys.json', JSON.stringify({ active: 'k1', keys: { k1: KEY_B } }));
    expect(fileKeyringSource(dir).load()).toEqual({
      active: 'k1',
      keys: { k1: KEY_B, legacy: KEY_A },
    });
  });

  test('rotation keeps old keys readable and persists the new active key', async () => {
    const crypto = createCrypto({ dataDir: dir });
    const before = crypto.encrypt('old');
    // Key ids derive from Date.now(); rotating in the same millisecond collides.
    await Bun.sleep(2);
    const id = crypto.rotateKey();

    const stored = JSON.parse(
      readFileSync(join(dir, 'encryption.keys.json'), 'utf-8'),
    ) as SerializedKeyring;
    expect(stored.active).toBe(id);
    expect(Object.keys(stored.keys)).toHaveLength(2);

    const restarted = createCrypto({ dataDir: dir });
    expect(restarted.decrypt(before)).toBe('old');
    expect(restarted.isEncryptedWithActiveKey(restarted.encrypt('new'))).toBe(true);
  });

  test('refuses a keys file readable by others', () => {
    writeOwnerOnly('encryption.keys.json', JSON.stringify({ active: 'k1', keys: { k1: KEY_A } }));
    chmodSync(join(dir, 'encryption.keys.json'), 0o644);
    expect(() => createCrypto({ dataDir: dir }).encrypt('x')).toThrow(/insecure permissions/);
  });

  test('refuses a malformed keys file and a missing active key', () => {
    writeOwnerOnly('encryption.keys.json', JSON.stringify({ keys: {} }));
    expect(() => createCrypto({ dataDir: dir }).encrypt('x')).toThrow(/Malformed/);

    writeOwnerOnly('encryption.keys.json', JSON.stringify({ active: 'k9', keys: { k1: KEY_A } }));
    expect(() => createCrypto({ dataDir: dir }).encrypt('x')).toThrow(/Active key "k9"/);
  });
});

describe('readOnlyKeyringSource', () => {
  test('encrypts and decrypts with the configured keys', () => {
    const writer = createCrypto({ dataDir: dir });
    const ciphertext = writer.encrypt('shared secret');
    const stored = fileKeyringSource(dir).load();

    const reader = createCrypto({ keyring: readOnlyKeyringSource(stored) });
    expect(reader.decrypt(ciphertext)).toBe('shared secret');
  });

  test('refuses to generate a key it cannot store', () => {
    const crypto = createCrypto({ keyring: readOnlyKeyringSource(null) });
    expect(() => crypto.encrypt('x')).toThrow(/read-only/);
  });

  test('refuses to rotate and keeps the current key active', () => {
    const crypto = createCrypto({
      keyring: readOnlyKeyringSource({ active: 'k1', keys: { k1: KEY_A } }),
    });
    expect(() => crypto.rotateKey()).toThrow(/read-only/);
    expect(crypto.encrypt('x').split(':')[1]).toBe('k1');
  });

  test('rejects a key that is not 32 bytes', () => {
    const crypto = createCrypto({
      keyring: readOnlyKeyringSource({ active: 'k1', keys: { k1: 'abcd' } }),
    });
    expect(() => crypto.encrypt('x')).toThrow(/not 32 bytes/);
  });
});
