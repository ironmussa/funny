/**
 * AES-256-GCM envelope encryption for user secrets (GitHub tokens,
 * provider API keys, etc.), with support for keyed rotation.
 *
 * Ciphertext formats:
 *
 *   Legacy:        `iv:authTag:ciphertext`                 (3 parts, unversioned)
 *   v1 (current):  `v1:keyId:iv:authTag:ciphertext`        (5 parts)
 *
 * Decrypt accepts both formats so existing rows stay readable after a
 * rotation. New writes always use the `v1` format tagged with the
 * currently active keyId.
 *
 * Key material lives in `encryption.keys.json` under the data dir:
 *
 *   { "active": "k2", "keys": { "k1": "<hex-64>", "k2": "<hex-64>" } }
 *
 * For backwards compatibility, the legacy single-file format
 * (`encryption.key`, one hex-encoded key with no id) is still recognised
 * and mapped to keyId `legacy`. New keys are appended to
 * `encryption.keys.json` without touching the legacy file — so existing
 * data keeps decrypting via the `legacy` entry and rotation does not
 * require a blocking backfill.
 *
 * Security ME-11 — this is the single source of truth, shared by
 * `@funny/server` and `@funny/runtime`. Both packages used to maintain
 * their own copies (one v1-aware, one legacy-only) which read the same
 * file but interpreted it differently. The factory pattern below lets
 * each package wire its own DATA_DIR and logger without depending on
 * the other's data-dir module.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const LEGACY_KEY_ID = 'legacy';
const CURRENT_VERSION = 'v1';

/**
 * Logger contract — keep narrow so each caller's structured logger
 * (Winston in runtime/server) plugs in without coupling.
 */
export interface CryptoLog {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
}

const SILENT_LOG: CryptoLog = {
  warn: () => undefined,
  info: () => undefined,
};

export interface CreateCryptoOptions {
  /** Data dir used to resolve `encryption.key` (legacy) + `encryption.keys.json` (v1). */
  dataDir: string;
  /** Optional logger; defaults to a silent stub. */
  log?: CryptoLog;
}

export interface CryptoApi {
  encrypt(plaintext: string): string;
  decrypt(encrypted: string): string | null;
  rotateKey(): string;
  /** Re-encrypt a value with the current active key. Returns null if input can't be decrypted. */
  reencrypt(encrypted: string): string | null;
  /** True if `encrypted` is in the legacy 3-part format. */
  isLegacyCiphertext(encrypted: string): boolean;
  /** True if `encrypted` was encrypted with the currently active key. */
  isEncryptedWithActiveKey(encrypted: string): boolean;
  /** Test-only: reset the in-memory cache. */
  __resetCryptoCacheForTests(): void;
}

interface KeyStore {
  active: string;
  keys: Record<string, Buffer>;
}

/**
 * Build a crypto API bound to `dataDir`. The returned object holds an
 * in-memory key cache, so each caller should `createCrypto` once and
 * reuse the instance — not per request.
 */
export function createCrypto({ dataDir, log = SILENT_LOG }: CreateCryptoOptions): CryptoApi {
  const LEGACY_KEY_PATH = resolve(dataDir, 'encryption.key');
  const KEYS_PATH = resolve(dataDir, 'encryption.keys.json');
  let cachedStore: KeyStore | null = null;
  let legacyDecryptLogged = false;

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

    // Legacy single-key file — mount under keyId `legacy` so old ciphertexts
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
        store = { active: LEGACY_KEY_ID, keys: { [LEGACY_KEY_ID]: legacyKey } };
      }
    }

    if (!store) {
      // First run: generate a fresh key and persist as the active key.
      const id = `k${Date.now().toString(36)}`;
      const key = randomBytes(32);
      try {
        writeKeysFile({ active: id, keys: { [id]: key.toString('hex') } });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
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

  function logLegacyDecryptOnce(): void {
    if (legacyDecryptLogged) return;
    legacyDecryptLogged = true;
    log.warn(
      'Decrypted a legacy (unversioned) ciphertext — schedule a re-encryption pass before this branch is removed',
      { namespace: 'crypto', deprecation: 'L3' },
    );
  }

  const api: CryptoApi = {
    encrypt(plaintext) {
      const { id, key } = getActiveKey();
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag();
      return `${CURRENT_VERSION}:${id}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
    },

    decrypt(encrypted) {
      try {
        const parts = encrypted.split(':');
        let keyId: string;
        let ivHex: string;
        let authTagHex: string;
        let ciphertext: string;

        if (parts.length === 3) {
          // Legacy unversioned `iv:authTag:ciphertext`. Mapped to keyId `legacy`.
          logLegacyDecryptOnce();
          keyId = LEGACY_KEY_ID;
          [ivHex, authTagHex, ciphertext] = parts;
        } else if (parts.length === 5 && parts[0] === CURRENT_VERSION) {
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
    },

    rotateKey() {
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
    },

    reencrypt(encrypted) {
      const plaintext = api.decrypt(encrypted);
      if (plaintext === null) return null;
      return api.encrypt(plaintext);
    },

    isLegacyCiphertext(encrypted) {
      return encrypted.split(':').length === 3;
    },

    isEncryptedWithActiveKey(encrypted) {
      const parts = encrypted.split(':');
      if (parts.length !== 5 || parts[0] !== CURRENT_VERSION) return false;
      const { id } = getActiveKey();
      return parts[1] === id;
    },

    __resetCryptoCacheForTests() {
      cachedStore = null;
      legacyDecryptLogged = false;
    },
  };

  return api;
}
