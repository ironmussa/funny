/**
 * Child-process environment scrubbing (security M8).
 *
 * Agents, PTY shells and user commands run code the runner does not control (a
 * prompt-injected agent can simply `env`). They must never inherit the
 * runner's / server's own credentials. Every child-env builder goes through
 * {@link buildChildEnv} (or {@link scrubSensitiveEnv}) instead of an ad-hoc
 * `{ ...process.env }`.
 *
 * Only funny's OWN infrastructure secrets are removed. User-facing provider
 * credentials (ANTHROPIC_API_KEY, OPENAI_API_KEY, GH_TOKEN, …) are left alone:
 * agents legitimately need them.
 */

/** Env vars holding funny infrastructure secrets. Never passed to a child. */
export const SENSITIVE_ENV_VARS: readonly string[] = [
  // Runner ↔ server
  'RUNNER_AUTH_SECRET',
  'RUNNER_INVITE_TOKEN',
  'RUNNER_TOKEN',
  'FUNNY_RUNNER_TOKEN',
  'FUNNY_RUNNER_FORWARDING_KEY',
  // Server-side shared secrets
  'SCHEDULER_AUTH_SECRET',
  'INGEST_WEBHOOK_SECRET',
  'REVIEW_WEBHOOK_SECRET',
  'BETTER_AUTH_SECRET',
  'AGENT_HTTP_AUTH_TOKEN',
  'FUNNY_AGENT_HTTP_AUTH_TOKEN',
  'WEB_PUSH_PRIVATE_KEY',
  'SMTP_PASS',
  'ADMIN_PASSWORD',
  // Database
  'DATABASE_URL',
  'DB_PASSWORD',
  'PGPASSWORD',
  // Deployment tooling
  'RAILWAY_TOKEN',
  'RAILWAY_API_TOKEN',
];

const SENSITIVE = new Set(SENSITIVE_ENV_VARS);

/** True when `name` is a funny infrastructure secret that children must not see. */
export function isSensitiveEnvVar(name: string): boolean {
  return SENSITIVE.has(name.toUpperCase());
}

/** Return a copy of `env` with every sensitive variable removed. */
export function scrubSensitiveEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isSensitiveEnvVar(key)) out[key] = value;
  }
  return out as T;
}

/**
 * Build a child env: the parent environment (default `process.env`) with
 * secrets stripped, then `extra` merged on top. `extra` is caller-controlled
 * and is NOT scrubbed, but the parent's secrets never leak through.
 */
export function buildChildEnv(
  extra?: Record<string, string | undefined>,
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return { ...scrubSensitiveEnv(base), ...extra };
}
