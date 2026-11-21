/**
 * Project secrets (openspec `project-secrets`): the rules every layer shares.
 *
 * Browser-safe. The server validates a name on write and filters again on
 * delivery, the client uses the same function for inline form errors, and the
 * runtime builds its redactor from here.
 */

import { PROVIDER_KEY_REGISTRY } from './models.js';

export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_NAME_MAX_LENGTH = 128;
/** Largest value, in UTF-8 bytes. */
export const SECRET_VALUE_MAX_BYTES = 32 * 1024;
/** Most secrets a project holds per scope (shared, or one member's personal). */
export const SECRET_MAX_PER_SCOPE = 100;
/** Values shorter than this are not redacted: they match too much ordinary text. */
export const SECRET_REDACTION_MIN_LENGTH = 8;

export type ProjectSecretScope = 'project' | 'user';

/**
 * Names a project secret may not take. A shared secret reaches every member's
 * runner, so a name that changes how a process is loaded (`NODE_OPTIONS`,
 * `LD_PRELOAD`) would run code there, and one that configures the provider
 * (`ANTHROPIC_BASE_URL`) would redirect their traffic together with their key.
 */
const RESERVED_EXACT: ReadonlySet<string> = new Set(
  [
    'PATH',
    'HOME',
    'SHELL',
    'USER',
    'IFS',
    'ENV',
    'BASH_ENV',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PYTHONPATH',
    'PYTHONSTARTUP',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'TEAM_SERVER_URL',
    'RUNNER_AUTH_SECRET',
    'BROWSER',
    'SSH_AUTH_SOCK',
    'SSH_ASKPASS',
    ...PROVIDER_KEY_REGISTRY.flatMap((key) => (key.envVar ? [key.envVar] : [])),
  ].map((name) => name.toUpperCase()),
);

export const RESERVED_SECRET_NAME_PREFIXES: readonly string[] = [
  'LD_',
  'DYLD_',
  'BUN_',
  'NPM_CONFIG_',
  'GIT_',
  'GH_',
  'ANTHROPIC_',
  'CLAUDE_',
  'CODEX_',
  'GEMINI_',
  'FUNNY_',
];

export type SecretNameProblem = 'empty' | 'too-long' | 'invalid-shape' | 'reserved';

/** The reason `name` cannot be a secret name, or `null` when it can. */
export function validateSecretName(name: string): SecretNameProblem | null {
  if (name.length === 0) return 'empty';
  if (name.length > SECRET_NAME_MAX_LENGTH) return 'too-long';
  if (!SECRET_NAME_PATTERN.test(name)) return 'invalid-shape';
  const upper = name.toUpperCase();
  if (RESERVED_EXACT.has(upper)) return 'reserved';
  if (RESERVED_SECRET_NAME_PREFIXES.some((prefix) => upper.startsWith(prefix))) return 'reserved';
  return null;
}

const SECRET_NAME_MESSAGES: Record<SecretNameProblem, string> = {
  empty: 'A secret needs a name.',
  'too-long': `A secret name has at most ${SECRET_NAME_MAX_LENGTH} characters.`,
  'invalid-shape':
    'A secret name is an environment variable name: letters, digits and underscores, not starting with a digit.',
  reserved:
    'This name is reserved: it changes how processes start, or funny, git or the agent provider uses it.',
};

export function secretNameMessage(problem: SecretNameProblem): string {
  return SECRET_NAME_MESSAGES[problem];
}

export type SecretValueProblem = 'empty' | 'too-large';

export function validateSecretValue(value: string): SecretValueProblem | null {
  if (value.length === 0) return 'empty';
  // UTF-8 needs at most 3 bytes per UTF-16 unit, so short values skip the encode.
  if (
    value.length * 3 > SECRET_VALUE_MAX_BYTES &&
    new TextEncoder().encode(value).length > SECRET_VALUE_MAX_BYTES
  ) {
    return 'too-large';
  }
  return null;
}

export function secretValueMessage(problem: SecretValueProblem): string {
  return problem === 'empty'
    ? 'A secret needs a value.'
    : `A secret value has at most ${SECRET_VALUE_MAX_BYTES / 1024} KiB.`;
}

export interface SecretValue {
  name: string;
  value: string;
}

/** Replaces known secret values in text with `[secret:NAME]`. */
export type SecretRedactor = (text: string) => string;

const identity: SecretRedactor = (text) => text;

/**
 * Builds a redactor for what funny stores and shows. Best effort: it finds a
 * value printed as is (whole, or line by line for a multi-line value such as a
 * PEM key), not one that was encoded or split. Longer needles go first, so a
 * value that contains another is replaced whole.
 */
export function createSecretRedactor(secrets: readonly SecretValue[]): SecretRedactor {
  const byNeedle = new Map<string, string>();
  const add = (needle: string, name: string) => {
    if (needle.length >= SECRET_REDACTION_MIN_LENGTH && !byNeedle.has(needle)) {
      byNeedle.set(needle, name);
    }
  };
  for (const { name, value } of secrets) {
    add(value, name);
    if (value.includes('\n')) {
      for (const line of value.split('\n')) add(line.trim(), name);
    }
  }
  if (byNeedle.size === 0) return identity;

  const needles = [...byNeedle.keys()].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const needle of needles) {
      if (out.includes(needle)) out = out.split(needle).join(`[secret:${byNeedle.get(needle)}]`);
    }
    return out;
  };
}
