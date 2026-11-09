/**
 * Server secrets behind one seam (docs/plans/cloudflare-portability.md, Phase 1).
 *
 * A host supplies a `SecretSource`. The default (Bun host) reads the
 * environment first, then a file under `DATA_DIR`, and writes a generated value
 * to that file (mode 0600) when neither exists. A host without a filesystem
 * supplies a source that only reads its bindings and cannot persist: generation
 * is then refused, so a missing secret fails loudly instead of silently changing
 * on every isolate.
 *
 * Keys the server uses only internally (never shared with runners or other
 * services) are derived from the auth secret with HKDF and a per-purpose label,
 * so they are stable across restarts and instances without new configuration.
 * Secrets that cross a trust boundary (RUNNER_AUTH_SECRET, …) stay separate and
 * are checked by `secret-check.ts`.
 *
 * The encryption keyring (user tokens at rest) has its own source: the files in
 * `DATA_DIR` by default, or — when `FUNNY_ENCRYPTION_KEYS` is set — that JSON,
 * read-only (`{"active":"k1","keys":{"k1":"<hex-64>"}}`). Setting it replaces
 * the files, so it must contain every key that encrypted existing rows.
 */

import { hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  fileKeyringSource,
  readOnlyKeyringSource,
  type KeyringSource,
  type SerializedKeyring,
} from '@funny/shared/lib/crypto';

import { DATA_DIR } from './data-dir.js';
import { log } from './logger.js';

export type ServerSecretName = 'auth-secret';

export interface SecretSource {
  /** The configured value, or undefined when it is not set. */
  read(name: ServerSecretName): string | undefined;
  /** Store a generated value. Returns false when the host cannot persist secrets. */
  persist(name: ServerSecretName, value: string): boolean;
}

/** Environment variable that overrides each secret. */
const ENV_VAR: Record<ServerSecretName, string> = {
  'auth-secret': 'BETTER_AUTH_SECRET',
};

/** Env first, then `<dataDir>/<name>`; generated values are written to that file. */
export function createFileSecretSource(opts: {
  env: Readonly<Record<string, string | undefined>>;
  dataDir: string;
}): SecretSource {
  return {
    read(name) {
      const fromEnv = opts.env[ENV_VAR[name]];
      if (fromEnv) return fromEnv;
      const path = resolve(opts.dataDir, name);
      if (!existsSync(path)) return undefined;
      const value = readFileSync(path, 'utf-8').trim();
      return value.length > 0 ? value : undefined;
    },
    persist(name, value) {
      mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(resolve(opts.dataDir, name), value, { mode: 0o600 });
      return true;
    },
  };
}

/** Bindings only (e.g. Worker secrets): nothing can be generated or stored. */
export function createReadOnlySecretSource(
  values: Readonly<Partial<Record<ServerSecretName, string>>>,
): SecretSource {
  return {
    read: (name) => values[name] || undefined,
    persist: () => false,
  };
}

let source: SecretSource | null = null;
const resolved = new Map<ServerSecretName, string>();
const derived = new Map<string, Buffer>();

/** Called once by the host before anything reads a secret. */
export function configureSecretSource(next: SecretSource): void {
  source = next;
  resolved.clear();
  derived.clear();
}

function currentSource(): SecretSource {
  source ??= createFileSecretSource({ env: process.env, dataDir: DATA_DIR });
  return source;
}

function getOrCreate(name: ServerSecretName): string {
  const cached = resolved.get(name);
  if (cached) return cached;
  const src = currentSource();
  let value = src.read(name);
  if (!value) {
    value = randomBytes(64).toString('hex');
    if (!src.persist(name, value)) {
      throw new Error(
        `Server secret "${name}" is not configured (set ${ENV_VAR[name]}) and this host cannot store a generated one`,
      );
    }
    log.info('Generated new server secret', { namespace: 'server-secrets', name });
  }
  resolved.set(name, value);
  return value;
}

/** Better Auth signing secret. */
export function getAuthSecret(): string {
  return getOrCreate('auth-secret');
}

/** Purposes of server-internal keys derived from the auth secret. */
export type DerivedKeyPurpose = 'oauth-callback-state';

/**
 * A 32-byte key for one server-internal purpose, derived from the auth secret
 * (HKDF-SHA256). Same auth secret → same key on every instance and restart;
 * different purposes → independent keys.
 */
export function deriveServerKey(purpose: DerivedKeyPurpose): Buffer {
  const cached = derived.get(purpose);
  if (cached) return cached;
  const key = Buffer.from(
    hkdfSync('sha256', getAuthSecret(), 'funny-server-keys', `funny/${purpose}/v1`, 32),
  );
  derived.set(purpose, key);
  return key;
}

// ── Encryption keyring ───────────────────────────────────────────

const KEYRING_ENV_VAR = 'FUNNY_ENCRYPTION_KEYS';

let keyringSource: KeyringSource | null = null;

/** Env `FUNNY_ENCRYPTION_KEYS` (read-only) when set, else the files in `dataDir`. */
export function defaultKeyringSource(opts: {
  env: Readonly<Record<string, string | undefined>>;
  dataDir: string;
}): KeyringSource {
  const raw = opts.env[KEYRING_ENV_VAR];
  if (!raw) return fileKeyringSource(opts.dataDir);
  let parsed: SerializedKeyring;
  try {
    parsed = JSON.parse(raw) as SerializedKeyring;
  } catch {
    throw new Error(`${KEYRING_ENV_VAR} is not valid JSON`);
  }
  if (typeof parsed?.active !== 'string' || typeof parsed.keys !== 'object' || !parsed.keys) {
    throw new Error(`${KEYRING_ENV_VAR} must look like {"active":"k1","keys":{"k1":"<hex-64>"}}`);
  }
  return readOnlyKeyringSource(parsed);
}

/** Called by a host that supplies its own keyring source. */
export function configureKeyringSource(next: KeyringSource): void {
  keyringSource = next;
}

/**
 * The keyring source, resolved on first use so a host can configure it after
 * modules load. Pass this to `createCrypto({ keyring })`.
 */
export const serverKeyringSource: KeyringSource = {
  load: () => currentKeyringSource().load(),
  save: (keyring) => currentKeyringSource().save(keyring),
};

function currentKeyringSource(): KeyringSource {
  keyringSource ??= defaultKeyringSource({ env: process.env, dataDir: DATA_DIR });
  return keyringSource;
}

/** Test-only: forget the configured sources and every cached value. */
export function resetServerSecretsForTests(): void {
  source = null;
  keyringSource = null;
  resolved.clear();
  derived.clear();
}
