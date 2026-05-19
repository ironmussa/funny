/**
 * AES-256-GCM envelope encryption for user secrets (GitHub tokens, provider
 * API keys, etc.), with support for keyed-rotation.
 *
 * Ciphertext formats:
 *
 *   Legacy:        `iv:authTag:ciphertext`                 (3 parts, unversioned)
 *   v1 (current):  `v1:keyId:iv:authTag:ciphertext`        (5 parts)
 *
 * Decrypt accepts both formats so existing rows stay readable after a rotation.
 * New writes always use the `v1` format tagged with the currently active keyId.
 *
 * Key material lives in `encryption.keys.json` under the data dir:
 *
 *   { "active": "k2", "keys": { "k1": "<hex-64>", "k2": "<hex-64>" } }
 *
 * For backwards compatibility, the legacy single-file format (`encryption.key`,
 * one hex-encoded key with no id) is still recognized and mapped to keyId
 * `legacy`. New keys are appended to `encryption.keys.json` without touching
 * the legacy file — so existing data keeps decrypting via the `legacy` entry
 * and rotation does not require a blocking backfill.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';

import { DATA_DIR } from './data-dir.js';
import { log } from './logger.js';

const LEGACY_KEY_PATH = resolve(DATA_DIR, 'encryption.key');
const KEYS_PATH = resolve(DATA_DIR, 'encryption.keys.json');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const LEGACY_KEY_ID = 'legacy';
const CURRENT_VERSION = 'v1';

type KeyStore = {
  active: string;
  keys: Record<string, Buffer>;
};

let cachedStore: KeyStore | null = null;

function assertSecureMode(path: string): void {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(
      `Encryption key file has insecure permissions: ${path} = ${(st.mode & 0o777).toString(8)}. Expected 0600.`,
    );
  }
}

function writeKeysFile(store: { active: string; keys: Record<string, string> }): void {
  const payload = JSON.stringify(store, null, 2);
  writeFileSync(KEYS_PATH, payload, { mode: 0o600 });
}

function loadStore(): KeyStore {
  if (cachedStore) return cachedStore;

  let store: KeyStore | null = null;

  if (existsSync(KEYS_PATH)) {
    assertSecureMode(KEYS_PATH);
    const parsed = JSON.parse(readFileSync(KEYS_PATH, 'utf-8')) as {
      active: string;
      keys: Record<string, string>;
    };
    if (!parsed.active || typeof parsed.keys !== 'object') {
      throw new Error('Malformed encryption.keys.json');
    }
    const keys: Record<string, Buffer> = {};
    for (const [id, hex] of Object.entries(parsed.keys)) {
      keys[id] = Buffer.from(hex, 'hex');
      if (keys[id].length !== 32) {
        throw new Error(`Encryption key "${id}" is not 32 bytes`);
      }
    }
    if (!keys[parsed.active]) {
      throw new Error(`Active key "${parsed.active}" not found in encryption.keys.json`);
    }
    store = { active: parsed.active, keys };
  }

  // Legacy single-key file — mount it under keyId `legacy` so old ciphertexts
  // still decrypt. If a newer keys file exists, the legacy key is still
  // registered there (we treat the legacy file as read-only after migration).
  if (existsSync(LEGACY_KEY_PATH)) {
    assertSecureMode(LEGACY_KEY_PATH);
    const legacyKey = Buffer.from(readFileSync(LEGACY_KEY_PATH, 'utf-8').trim(), 'hex');
    if (legacyKey.length !== 32) {
      throw new Error('Legacy encryption.key is not 32 bytes');
    }
    if (store) {
      if (!store.keys[LEGACY_KEY_ID]) {
        store.keys[LEGACY_KEY_ID] = legacyKey;
      }
    } else {
      // No new keys file yet — treat legacy as the active key.
      store = { active: LEGACY_KEY_ID, keys: { [LEGACY_KEY_ID]: legacyKey } };
    }
  }

  if (!store) {
    // First run: generate a fresh key and persist as the active key.
    const id = `k${Date.now().toString(36)}`;
    const key = randomBytes(32);
    try {
      writeKeysFile({ active: id, keys: { [id]: key.toString('hex') } });
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        cachedStore = null;
        return loadStore();
      }
      throw err;
    }
    store = { active: id, keys: { [id]: key } };
  }

  cachedStore = store;
  return store;
}

function getActiveKey(): { id: string; key: Buffer } {
  const store = loadStore();
  return { id: store.active, key: store.keys[store.active] };
}

function getKeyById(id: string): Buffer | null {
  const store = loadStore();
  return store.keys[id] ?? null;
}

let legacyDecryptLogged = false;
function logLegacyDecryptOnce(): void {
  if (legacyDecryptLogged) return;
  legacyDecryptLogged = true;
  log.warn(
    'Decrypted a legacy (unversioned) ciphertext — schedule a re-encryption pass before this branch is removed',
    { namespace: 'crypto', deprecation: 'L3' },
  );
}

/**
 * Re-encrypt a value with the active key in the current `v1` format. Use for
 * lazy migration of legacy ciphertexts: read with `decrypt`, then write back
 * with `reencrypt` so the legacy branch can eventually be deleted.
 *
 * Returns null when the input cannot be decrypted (caller should leave the
 * row untouched).
 */
export function reencrypt(encrypted: string): string | null {
  const plaintext = decrypt(encrypted);
  if (plaintext === null) return null;
  return encrypt(plaintext);
}

/** True if `encrypted` is in the legacy 3-part format. */
export function isLegacyCiphertext(encrypted: string): boolean {
  const parts = encrypted.split(':');
  return parts.length === 3;
}

export function encrypt(plaintext: string): string {
  const { id, key } = getActiveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${CURRENT_VERSION}:${id}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encrypted: string): string | null {
  try {
    const parts = encrypted.split(':');

    let keyId: string;
    let ivHex: string;
    let authTagHex: string;
    let ciphertext: string;

    if (parts.length === 3) {
      // Security L3 — legacy unversioned format: `iv:authTag:ciphertext`.
      //
      // Deprecated. New writes always use `v1` (see encrypt()); the only
      // remaining producers are pre-v1 rows already in the database. We log
      // once per process so operators see when legacy ciphertext is still in
      // play, and so this branch becomes auditable to remove in a future
      // release once a backfill migration has re-encrypted everything.
      logLegacyDecryptOnce();
      keyId = LEGACY_KEY_ID;
      [ivHex, authTagHex, ciphertext] = parts;
    } else if (parts.length === 5 && parts[0] === CURRENT_VERSION) {
      // v1 format: v1:keyId:iv:authTag:ciphertext
      [, keyId, ivHex, authTagHex, ciphertext] = parts;
    } else {
      return null;
    }

    const key = getKeyById(keyId);
    if (!key) {
      log.warn('Decrypt failed: unknown keyId', { namespace: 'crypto', keyId });
      return null;
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
  } catch {
    return null;
  }
}

/**
 * Generate a new key, add it to the store, and promote it to `active`.
 * Previous keys stay available so old ciphertexts keep decrypting until they
 * are opportunistically re-encrypted on next write (or by an explicit backfill).
 *
 * Returns the new key id.
 */
export function rotateKey(): string {
  const store = loadStore();
  const id = `k${Date.now().toString(36)}`;
  if (store.keys[id]) {
    throw new Error('Key id collision — retry');
  }
  const key = randomBytes(32);
  store.keys[id] = key;
  store.active = id;
  cachedStore = store;

  const serialized: Record<string, string> = {};
  for (const [kid, buf] of Object.entries(store.keys)) {
    serialized[kid] = buf.toString('hex');
  }
  writeKeysFile({ active: id, keys: serialized });
  log.info('Encryption key rotated', { namespace: 'crypto', newKeyId: id });
  return id;
}

/**
 * True if the ciphertext was encrypted with the currently active key.
 * Useful for backfill jobs to skip rows that are already up-to-date.
 */
export function isEncryptedWithActiveKey(encrypted: string): boolean {
  const parts = encrypted.split(':');
  const { id } = getActiveKey();
  if (parts.length === 5 && parts[0] === CURRENT_VERSION) {
    return parts[1] === id;
  }
  return false;
}

/** Test-only: reset the module cache. */
export function __resetCryptoCacheForTests(): void {
  cachedStore = null;
}
