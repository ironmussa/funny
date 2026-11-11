/**
 * @domain subdomain: Runner Infrastructure
 * @domain subdomain-type: supporting
 * @domain type: domain-service
 * @domain layer: application
 *
 * The deployment's GitHub App (sandbox-github-app-tokens). One App per funny
 * server: its private key mints tokens for every repository it is installed
 * on, so it never leaves this server. It comes from the environment
 * (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`, which win) or from the App
 * manifest flow, stored in `instance_settings` with the key encrypted.
 */

import { parseStoredJson } from '@funny/shared/json-validation';
import { eq } from 'drizzle-orm';
import { ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { instanceSettings } from '../../db/schema.js';
import { decrypt, encrypt } from '../../lib/crypto.js';

const APP_KEY = 'github_app';
const PRIVATE_KEY_KEY = 'github_app_private_key';

export interface GithubAppConfig {
  appId: string;
  /** PEM private key. Server-only: never returned by an API or sent to a runner. */
  privateKey: string;
  /** App slug (for install links), when known. */
  slug: string | null;
  /** Account or organization that owns the App, when known. */
  owner: string | null;
  source: 'environment' | 'database';
}

/** What the manifest conversion returns and the database keeps (key encrypted). */
export interface StoredGithubApp {
  appId: string;
  slug: string;
  owner: string;
  privateKey: string;
}

/** Key/value storage for instance settings (the `instance_settings` table in production). */
export interface SettingsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const storedAppSchema = z.object({
  appId: z.string().min(1),
  slug: z.string().min(1),
  owner: z.string().min(1),
});

const toMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Platforms that store one-line variables keep the PEM's newlines as `\n`. */
function normalizePem(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

function looksLikePem(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/.test(value);
}

/** The App from the environment, or null when it is not set. Malformed values are an error. */
function fromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): GithubAppConfig | null | Error {
  const appId = env.GITHUB_APP_ID?.trim();
  const rawKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId && !rawKey) return null;
  if (!appId || !rawKey) {
    return new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set together');
  }
  if (!/^\d+$/.test(appId)) return new Error('GITHUB_APP_ID must be the numeric App ID');
  const privateKey = normalizePem(rawKey).trim();
  if (!looksLikePem(privateKey))
    return new Error('GITHUB_APP_PRIVATE_KEY is not a PEM private key');
  return {
    appId,
    privateKey,
    slug: env.GITHUB_APP_SLUG?.trim() || null,
    owner: null,
    source: 'environment',
  };
}

async function fromDatabase(store: SettingsStore): Promise<GithubAppConfig | null> {
  const [rawApp, encryptedKey] = await Promise.all([
    store.get(APP_KEY),
    store.get(PRIVATE_KEY_KEY),
  ]);
  if (!rawApp || !encryptedKey) return null;
  const app = parseStoredJson(storedAppSchema, rawApp, 'github app settings');
  const privateKey = decrypt(encryptedKey);
  if (!app.ok || !privateKey) return null;
  return { ...app.value, privateKey, source: 'database' };
}

/** The deployment's App: environment first, then the stored one; null when none is configured. */
export function loadGithubAppConfig(
  env: Readonly<Record<string, string | undefined>>,
  store: SettingsStore,
): ResultAsync<GithubAppConfig | null, string> {
  const environment = fromEnvironment(env);
  if (environment instanceof Error) {
    return ResultAsync.fromPromise(Promise.reject(environment), toMessage);
  }
  if (environment) return ResultAsync.fromSafePromise(Promise.resolve(environment));
  return ResultAsync.fromPromise(fromDatabase(store), toMessage);
}

/** Store the App the manifest flow created; the private key is encrypted at rest. */
export function saveGithubApp(
  store: SettingsStore,
  app: StoredGithubApp,
): ResultAsync<void, string> {
  return ResultAsync.fromPromise(
    Promise.all([
      store.set(APP_KEY, JSON.stringify({ appId: app.appId, slug: app.slug, owner: app.owner })),
      store.set(PRIVATE_KEY_KEY, encrypt(app.privateKey)),
    ]).then(() => undefined),
    toMessage,
  );
}

/** Forget the stored App (the environment one, if any, is unaffected). */
export function deleteGithubApp(store: SettingsStore): ResultAsync<void, string> {
  return ResultAsync.fromPromise(
    Promise.all([store.delete(APP_KEY), store.delete(PRIVATE_KEY_KEY)]).then(() => undefined),
    toMessage,
  );
}

/** `instance_settings` as a `SettingsStore`. */
export const sqlSettingsStore: SettingsStore = {
  async get(key) {
    const [row] = await db
      .select({ value: instanceSettings.value })
      .from(instanceSettings)
      .where(eq(instanceSettings.key, key));
    return row?.value ?? null;
  },
  async set(key, value) {
    const updatedAt = new Date().toISOString();
    await db
      .insert(instanceSettings)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt } });
  },
  async delete(key) {
    await db.delete(instanceSettings).where(eq(instanceSettings.key, key));
  },
};
