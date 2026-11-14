/**
 * The factory's secrets: the model credential, the Factory App's id and
 * private key, and the sandbox provider credential (only when a project uses
 * a sandbox). They come from the environment or, on a TTY, a prompt; they are
 * held in memory only, and `redactor` keeps them out of every log line.
 */

import { signAppJwt } from '@funny/core/github-app';
import { err, ok, type Result } from 'neverthrow';

import { usesSandbox, type FactorySettings } from './schema.js';

export interface FactorySecrets {
  modelKey: string;
  app: { appId: string; privateKey: string };
  sandboxCredential: string | null;
}

export interface SecretSpec {
  envName: string;
  label: string;
  /** Pasted over several lines (a PEM key), ended by its `-----END` line. */
  multiline: boolean;
}

/** Asks for one secret on the terminal without echoing it; null when none was given. */
export type SecretPrompt = (question: string, secret: SecretSpec) => Promise<string | null>;

const MODEL_KEY: SecretSpec = {
  envName: 'FUNNY_FACTORY_MODEL_KEY',
  label: 'model credential (a dedicated key with a spending limit)',
  multiline: false,
};
const APP_ID: SecretSpec = {
  envName: 'FUNNY_FACTORY_APP_ID',
  label: 'Factory App id',
  multiline: false,
};
const APP_KEY: SecretSpec = {
  envName: 'FUNNY_FACTORY_APP_PRIVATE_KEY',
  label: 'Factory App private key (PEM)',
  multiline: true,
};
const SANDBOX_CREDENTIAL: SecretSpec = {
  envName: 'FUNNY_FACTORY_SANDBOX_CREDENTIAL',
  label: 'sandbox provider credential',
  multiline: false,
};

export interface SecretSources {
  env: Readonly<Record<string, string | undefined>>;
  isTTY: boolean;
  prompt: SecretPrompt;
}

/** A one-line env value may carry `\n` escapes (a PEM in a `.env` file). */
const fromEnv = (spec: SecretSpec, value: string) =>
  (spec.multiline ? value.replace(/\\n/g, '\n') : value).trim();

export async function resolveFactorySecrets(
  settings: FactorySettings,
  sources: SecretSources,
): Promise<Result<FactorySecrets, string>> {
  const specs = [
    MODEL_KEY,
    APP_ID,
    APP_KEY,
    ...(usesSandbox(settings) ? [SANDBOX_CREDENTIAL] : []),
  ];
  const values = new Map<string, string>();
  const missing: SecretSpec[] = [];
  for (const spec of specs) {
    const value = sources.env[spec.envName];
    if (value?.trim()) values.set(spec.envName, fromEnv(spec, value));
    else missing.push(spec);
  }
  if (missing.length > 0 && !sources.isTTY) {
    return err(
      `Missing secrets: set ${missing.map((s) => s.envName).join(', ')} in the environment, or start on a terminal to be asked for them.`,
    );
  }
  for (const spec of missing) {
    const answer = (await sources.prompt(`${spec.label} (${spec.envName}): `, spec))?.trim();
    if (!answer) return err(`Missing secret ${spec.envName}`);
    values.set(spec.envName, answer);
  }

  const appId = values.get(APP_ID.envName)!;
  if (!/^\d+$/.test(appId)) return err(`${APP_ID.envName} must be the App's numeric id`);
  const privateKey = values.get(APP_KEY.envName)!;
  if (signAppJwt(appId, privateKey).isErr()) {
    return err(`${APP_KEY.envName} is not a usable private key (it cannot sign the App's JWT)`);
  }
  return ok({
    modelKey: values.get(MODEL_KEY.envName)!,
    app: { appId, privateKey },
    sandboxCredential: values.get(SANDBOX_CREDENTIAL.envName) ?? null,
  });
}

/** Every variable a secret may come from. */
const SECRET_ENV_NAMES = [MODEL_KEY, APP_ID, APP_KEY, SANDBOX_CREDENTIAL].map((s) => s.envName);

/** The secret values present in an environment (redacted even before they are checked). */
export function secretEnvValues(env: SecretSources['env']): string[] {
  return SECRET_ENV_NAMES.flatMap((name) => {
    const value = env[name];
    return value ? [value, value.replace(/\\n/g, '\n')] : [];
  });
}

/** Drops the secret variables, so no process the factory starts inherits them. */
export function forgetSecretEnv(env: Record<string, string | undefined>): void {
  for (const name of SECRET_ENV_NAMES) delete env[name];
}

/** The values to redact for resolved secrets (the App id is not a secret). */
export function secretValues(secrets: FactorySecrets): string[] {
  return [secrets.modelKey, secrets.app.privateKey, secrets.sandboxCredential ?? ''];
}

/**
 * Replaces every secret in a text with `[redacted]`: whole values, each line
 * of a multi-line one, and their JSON-escaped forms. Fragments shorter than 4
 * characters and a PEM's `-----BEGIN/END-----` lines are left as they are.
 */
export function redactor(secrets: string[]): (text: string) => string {
  const values = secrets
    .filter((v) => v.length > 0)
    .flatMap((v) => [v, JSON.stringify(v).slice(1, -1), ...v.split('\n')])
    .map((v) => v.trim())
    .filter((v) => v.length >= 4 && !v.startsWith('-----'))
    .sort((a, b) => b.length - a.length);
  const unique = [...new Set(values)];
  return (text) => unique.reduce((out, value) => out.split(value).join('[redacted]'), text);
}
