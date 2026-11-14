/**
 * Reads and validates the factory settings file. Every refusal names the
 * field at fault (`projects.0.repo: expected owner/name`), and a file that
 * looks like it holds a secret is refused without repeating the value: secrets
 * come only from the environment or a prompt (`secrets.ts`).
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';

import { productionSandboxProviders, resolveSandboxSize } from '@funny/sandbox';
import { err, ok, type Result } from 'neverthrow';
import { parse as parseYaml, YAMLError } from 'yaml';
import type { z } from 'zod';

import { factorySettingsSchema, type FactorySettings } from './schema.js';

/** Key names that say "this is a secret" (`author` is not `auth`). */
const SECRET_KEY_RE =
  /(secret|token|passw(or)?d|credential|bearer|(^|[_-])(key|pat|pem|auth)($|[_-])|[_-]key$|private[_-]?key|api[_-]?key)/i;
/** Values shaped like well-known credentials. */
const SECRET_VALUE_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

const fieldName = (path: ReadonlyArray<PropertyKey>) => path.map(String).join('.') || '(root)';
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Where a YAML syntax error is, without its message: the library quotes the
 * offending line, which may hold a secret.
 */
function yamlErrorAt(error: unknown): string {
  if (error instanceof YAMLError && error.linePos) {
    const [{ line, col }] = error.linePos;
    return `${error.code} at line ${line}, column ${col}`;
  }
  return 'unreadable YAML';
}

/** Every key path and string value of a parsed YAML document. */
function* entries(value: unknown, path: string[] = []): Generator<[string[], unknown]> {
  yield [path, value];
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) yield* entries(item, [...path, key]);
  }
}

/** The first secret-looking key or value, by field name (never the value). */
function findSecret(document: unknown): string | null {
  for (const [path, value] of entries(document)) {
    const key = path.at(-1);
    if (key && SECRET_KEY_RE.test(key)) return `${fieldName(path)}: looks like a secret key`;
    if (typeof value === 'string' && SECRET_VALUE_RES.some((re) => re.test(value))) {
      return `${fieldName(path)}: looks like a secret`;
    }
  }
  return null;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const unknown =
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => `${fieldName([...issue.path, key])}: unknown field`)
          : null;
      return unknown ? unknown.join('\n') : `${fieldName(issue.path)}: ${issue.message}`;
    })
    .join('\n');
}

/** Checks that need more than the schema: the sandbox provider and size, the project paths. */
function checkEnvironment(
  settings: FactorySettings,
  baseDir: string,
): Result<FactorySettings, string> {
  if (settings.sandbox) {
    const registry = productionSandboxProviders();
    if (registry.isErr()) return err(`sandbox.provider: ${registry.error.kind}`);
    const wanted = settings.sandbox.provider;
    const provider = registry.value.list().find((p) => p.id === wanted);
    if (!provider) {
      const known = registry.value
        .list()
        .map((p) => p.id)
        .join(', ');
      return err(
        `sandbox.provider: unknown provider "${settings.sandbox.provider}" (known: ${known})`,
      );
    }
    if (!resolveSandboxSize(provider.capabilities, settings.sandbox.size)) {
      return err(`sandbox.size: ${provider.id} has no size "${settings.sandbox.size}"`);
    }
  }
  const projects = [];
  for (const [i, project] of settings.projects.entries()) {
    const path = isAbsolute(project.path) ? project.path : resolve(baseDir, project.path);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return err(`projects.${i}.path: ${path} is not a directory`);
    }
    projects.push({ ...project, path });
  }
  return ok({ ...settings, projects });
}

export function loadFactorySettings(configPath: string): Result<FactorySettings, string> {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    return err(`Cannot read ${configPath}: ${messageOf(error)}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return err(`${configPath} is not valid YAML: ${yamlErrorAt(error)}`);
  }
  const secret = findSecret(raw);
  if (secret) {
    return err(
      `${secret}. Secrets are never read from the settings file: give them in the environment or at the prompt.`,
    );
  }
  const parsed = factorySettingsSchema.safeParse(raw ?? {});
  if (!parsed.success)
    return err(`Invalid settings in ${configPath}:\n${describeIssues(parsed.error)}`);
  return checkEnvironment(parsed.data, dirname(configPath)).mapErr(
    (message) => `Invalid settings in ${configPath}:\n${message}`,
  );
}
