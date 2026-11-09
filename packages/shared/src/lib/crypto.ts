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
 * Where the keyring lives is a `KeyringSource`: by default the files above
 * (`fileKeyringSource(dataDir)`); a host without a filesystem passes a
 * read-only source (`readOnlyKeyringSource`, e.g. from a secret binding), and
 * then generating or rotating a key is refused instead of being lost.
 *
 * Security ME-11 — this is the single source of truth, shared by
 * `@funny/server` and `@funny/runtime`. Both packages used to maintain
 * their own copies (one v1-aware, one legacy-only) which read the same
 * file but interpreted it differently. The factory pattern below lets
 * each package wire its own DATA_DIR and logger without depending on
 * the other's data-dir module.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs';
import { resolve } from 'path';

import { z } from 'zod';

import { parseStoredJson } from '../json-validation.js';

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

/** A keyring as stored: key ids → hex-encoded 32-byte keys, plus the active id. */
export interface SerializedKeyring {
  active: string;
  keys: Record<string, string>;
}

/** Shape of a stored keyring (`encryption.keys.json`, or a secret binding). */
export const serializedKeyringSchema = z.object({
  active: z.string().min(1),
  keys: z.record(z.string(), z.string()),
});

/** Where the keyring is read from and written to. */
export interface KeyringSource {
  /** The stored keyring, or null when none exists yet. */
  load(): SerializedKeyring | null;
  /** Persist the keyring. Returns false when this source cannot store keys. */
  save(keyring: SerializedKeyring): boolean;
}

export interface CreateCryptoOptions {
  /**
   * Data dir used to resolve `encryption.key` (legacy) + `encryption.keys.json`
   * (v1). Ignored when `keyring` is given.
   */
  dataDir?: string;
  /** Keyring source; defaults to `fileKeyringSource(dataDir)`. */
  keyring?: KeyringSource;
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

function assertSecureMode(path: string): void {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(
      `Encryption key file has insecure permissions: ${path} = ${(st.mode & 0o777).toString(8)}. Expected 0600.`,
    );
  }
}

/**
 * The keyring in `<dataDir>/encryption.keys.json`, merged with the legacy
 * `<dataDir>/encryption.key` (mounted as keyId `legacy`, never rewritten).
 * Both files must be owner-only (0600).
 */
export function fileKeyringSource(dataDir: string): KeyringSource {
  const legacyKeyPath = resolve(dataDir, 'encryption.key');
  const keysPath = resolve(dataDir, 'encryption.keys.json');
  return {
    load() {
      let keyring: SerializedKeyring | null = null;
      if (existsSync(keysPath)) {
        assertSecureMode(keysPath);
        const parsed = parseStoredJson(
          serializedKeyringSchema,
          readFileSync(keysPath, 'utf-8'),
          'encryption.keys.json',
        );
        if (!parsed.ok) throw new Error(`Malformed encryption.keys.json (${parsed.error})`);
        keyring = parsed.value;
      }
      // Legacy single-key file — mount under keyId `legacy` so old ciphertexts
      // still decrypt. If a newer keys file exists, the legacy key is still
      // registered there (we treat the legacy file as read-only after migration).
      if (existsSync(legacyKeyPath)) {
        assertSecureMode(legacyKeyPath);
        const legacyHex = readFileSync(legacyKeyPath, 'utf-8').trim();
        if (Buffer.from(legacyHex, 'hex').length !== 32) {
          throw new Error('Legacy encryption.key is not 32 bytes');
        }
        if (keyring) {
          keyring.keys[LEGACY_KEY_ID] ??= legacyHex;
        } else {
          keyring = { active: LEGACY_KEY_ID, keys: { [LEGACY_KEY_ID]: legacyHex } };
        }
      }
      return keyring;
    },
    save(keyring) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      // Write a temp file and rename it over the keyring, so a crash mid-write
      // can never leave a truncated keyring (every stored token would become
      // unreadable).
      const tmpPath = `${keysPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        writeFileSync(tmpPath, JSON.stringify(keyring, null, 2), { mode: 0o600, flag: 'wx' });
        renameSync(tmpPath, keysPath);
      } catch (error) {
        rmSync(tmpPath, { force: true });
        throw error;
      }
      return true;
    },
  };
}

/**
 * A fixed keyring (e.g. JSON from a secret binding:
 * `{"active":"k1","keys":{"k1":"<hex-64>"}}`). It cannot store keys, so a
 * missing keyring or a rotation fails instead of producing keys that are lost.
 */
export function readOnlyKeyringSource(keyring: SerializedKeyring | null): KeyringSource {
  return {
    load: () => (keyring ? { active: keyring.active, keys: { ...keyring.keys } } : null),
    save: () => false,
  };
}

/** Parse and validate a stored keyring into key buffers. */
function toKeyStore(serialized: SerializedKeyring): KeyStore {
  const keys: Record<string, Buffer> = {};
  for (const [id, hex] of Object.entries(serialized.keys)) {
    keys[id] = Buffer.from(hex, 'hex');
    if (keys[id].length !== 32) {
      throw new Error(`Encryption key "${id}" is not 32 bytes`);
    }
  }
  if (!keys[serialized.active]) {
    throw new Error(`Active key "${serialized.active}" not found in the encryption keyring`);
  }
  return { active: serialized.active, keys };
}

function serialize(store: KeyStore): SerializedKeyring {
  const keys: Record<string, string> = {};
  for (const [id, buf] of Object.entries(store.keys)) keys[id] = buf.toString('hex');
  return { active: store.active, keys };
}

/**
 * Build a crypto API bound to a keyring source (default: the files in
 * `dataDir`). The returned object holds an in-memory key cache, so each caller
 * should `createCrypto` once and reuse the instance — not per request.
 */
export function createCrypto({
  dataDir,
  keyring,
  log = SILENT_LOG,
}: CreateCryptoOptions): CryptoApi {
  const source =
    keyring ??
    (dataDir !== undefined
      ? fileKeyringSource(dataDir)
      : (() => {
          throw new Error('createCrypto needs a dataDir or a keyring source');
        })());
  let cachedStore: KeyStore | null = null;
  let legacyDecryptLogged = false;

  function persist(store: KeyStore, what: string): void {
    if (!source.save(serialize(store))) {
      throw new Error(
        `Cannot ${what}: this host's encryption keyring is read-only (configure the keyring instead)`,
      );
    }
  }

  function loadStore(): KeyStore {
    if (cachedStore) return cachedStore;
    const serialized = source.load();
    let store: KeyStore;
    if (serialized) {
      store = toKeyStore(serialized);
    } else {
      // First run: generate a fresh key and persist as the active key.
      const id = `k${Date.now().toString(36)}`;
      store = { active: id, keys: { [id]: randomBytes(32) } };
      persist(store, 'create an encryption key');
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
      const current = loadStore();
      const id = `k${Date.now().toString(36)}`;
      if (current.keys[id]) {
        throw new Error('Key id collision — retry');
      }
      const next: KeyStore = { active: id, keys: { ...current.keys, [id]: randomBytes(32) } };
      persist(next, 'rotate the encryption key');
      cachedStore = next;
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
