#!/usr/bin/env bun
/**
 * Fitness function: the tRPC browser API (openspec change adopt-trpc-browser-api).
 *
 * Rules:
 *  1. Isolation (design D1). Production code in packages/api/src imports only
 *     relative modules, `@trpc/server`, `zod`, `neverthrow` and the browser-safe
 *     `@funny/shared` entries in SHARED_ALLOWED. Clients import `type AppRouter`
 *     from this package, so a server, database, Bun or Node import here would
 *     land in every client's typecheck.
 *  2. Migrated groups (design D6). Production code in packages/client/src does
 *     not call a migrated group over REST (`request('/automations…')`,
 *     `callEndpoint(...)` with the group's contract): it goes through tRPC.
 *  3. Type-only entry. Production code in packages/client/src imports the
 *     `@funny/api` entry with `import type` only. That entry builds the router,
 *     and `@trpc/server` throws when it initializes in a browser. Runtime values
 *     come from a browser-safe subpath (`@funny/api/path`).
 *
 * `--self-test` checks the rules against allowed and forbidden fixtures.
 * Exits non-zero on violation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const API_SRC = join(ROOT, 'packages/api/src');
const CLIENT_SRC = join(ROOT, 'packages/client/src');

const PACKAGES_ALLOWED = new Set(['@trpc/server', 'zod', 'neverthrow']);
const SHARED_ALLOWED = [
  /^@funny\/shared$/,
  /^@funny\/shared\/errors$/,
  /^@funny\/shared\/models$/,
  /^@funny\/shared\/contracts\/[\w-]+$/,
  /^@funny\/shared\/types\/[\w-]+$/,
];

/**
 * Route groups whose web-client calls go through tRPC: REST path prefix, contract
 * export, and the sub-paths that stay REST (`restOnly`, e.g. pipeline approval
 * gates, which the server may proxy to a runner). A group without `path` is
 * checked only by its contract: most `/threads` routes go to the runner and stay
 * REST, so only its contract endpoints moved.
 */
const MIGRATED_GROUPS: Array<{ path?: string; contract: string; restOnly?: string[] }> = [
  { path: '/automations', contract: 'automationsContract' },
  { path: '/pipelines', contract: 'pipelinesContract', restOnly: ['/approvals'] },
  { contract: 'threadsContract' },
];

const IMPORT_SPECIFIER =
  /(?:^|[\s;])(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/;

function isExcluded(rel: string): boolean {
  return rel.includes('__tests__/') || /\.(?:test|spec|stories)\.tsx?$/.test(rel);
}

function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isAllowedApiImport(specifier: string): boolean {
  if (specifier.startsWith('.')) return true;
  if (specifier.startsWith('@funny/shared')) {
    return SHARED_ALLOWED.some((pattern) => pattern.test(specifier));
  }
  return PACKAGES_ALLOWED.has(packageOf(specifier));
}

/** Code of a line without its `//` comment; empty for blank and block-comment lines. */
function codeOf(line: string): string {
  const code = line.replace(/\/\/.*$/, '').trim();
  return code.startsWith('*') ? '' : code;
}

export function findApiViolations(rel: string, source: string): string[] {
  const found: string[] = [];
  source.split('\n').forEach((line, index) => {
    const match = IMPORT_SPECIFIER.exec(codeOf(line));
    const specifier = match?.[1] ?? match?.[2] ?? match?.[3];
    if (specifier && !isAllowedApiImport(specifier)) {
      found.push(`[api imports ${specifier}] packages/api/src/${rel}:${index + 1}`);
    }
  });
  return found;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Excludes the group's REST-only sub-paths from the "REST call" rule. */
const restOnlyLookahead = (restOnly: string[]) =>
  restOnly.length === 0 ? '' : `(?!(?:${restOnly.map(escape).join('|')})(?:[/?\`'"]|$))`;

const MIGRATED_RULES = MIGRATED_GROUPS.flatMap(({ path, contract, restOnly = [] }) => [
  ...(path === undefined
    ? []
    : [
        {
          label: `REST call to migrated group ${path}`,
          pattern: new RegExp(
            `\\b(?:request|requestInThread)\\s*(?:<[^(]*>)?\\s*\\(\\s*[\`'"]${escape(path)}${restOnlyLookahead(restOnly)}(?:[/?\`'"]|$)`,
          ),
        },
      ]),
  { label: `contract ${contract} of a migrated group`, pattern: new RegExp(`\\b${contract}\\b`) },
]);

/** A statement that loads the `@funny/api` entry at runtime (anything but `import type … from`). */
const API_ENTRY_SPECIFIER = /['"]@funny\/api['"]/;
const TYPE_ONLY_STATEMENT = /^(?:import|export)\s+type\b/;

/** Lines of the import/export statements (possibly multi-line) that load the `@funny/api` entry at runtime. */
function findRuntimeApiEntryImports(source: string): number[] {
  const lines = source.split('\n');
  const found: number[] = [];
  lines.forEach((line, index) => {
    const code = codeOf(line);
    if (!API_ENTRY_SPECIFIER.test(code)) return;
    // Walk back to the line the statement starts on.
    let start = index;
    while (start > 0 && !/^(?:import|export)\b/.test(codeOf(lines[start]))) start--;
    if (!TYPE_ONLY_STATEMENT.test(codeOf(lines[start]))) found.push(index + 1);
  });
  return found;
}

export function findClientViolations(rel: string, source: string): string[] {
  const found: string[] = findRuntimeApiEntryImports(source).map(
    (line) =>
      `[runtime import of @funny/api; use \`import type\` or @funny/api/path] packages/client/src/${rel}:${line}`,
  );
  source.split('\n').forEach((line, index) => {
    const code = codeOf(line);
    if (!code) return;
    for (const rule of MIGRATED_RULES) {
      if (rule.pattern.test(code)) {
        found.push(`[${rule.label}] packages/client/src/${rel}:${index + 1}  ${line.trim()}`);
      }
    }
  });
  return found;
}

function runSelfTest(): void {
  const apiCases: Array<{ source: string; violates: boolean }> = [
    { source: "import { z } from 'zod';", violates: false },
    { source: "import { initTRPC } from '@trpc/server';", violates: false },
    { source: "import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';", violates: false },
    { source: "import { ok } from 'neverthrow';", violates: false },
    { source: "import { unwrap } from '../failure.js';", violates: false },
    { source: "import type { Automation } from '@funny/shared';", violates: false },
    { source: "import { x } from '@funny/shared/contracts/automations';", violates: false },
    { source: "import type { DomainError } from '@funny/shared/errors';", violates: false },
    { source: "import { db } from '@funny/server/db';", violates: true },
    { source: "import { schema } from '@funny/shared/db/schema';", violates: true },
    {
      source: "import { createThreadRepository } from '@funny/shared/repositories';",
      violates: true,
    },
    { source: "import { Database } from 'bun:sqlite';", violates: true },
    { source: "import { readFileSync } from 'node:fs';", violates: true },
    { source: "import { Hono } from 'hono';", violates: true },
    { source: "export { gitRead } from '@funny/core/git';", violates: true },
    { source: "const m = await import('@funny/runtime');", violates: true },
    { source: "// import { db } from '@funny/server/db';", violates: false },
  ];
  const clientCases: Array<{ source: string; violates: boolean }> = [
    { source: "request<Automation[]>('/automations')", violates: true },
    { source: 'request(`/automations/${id}/runs`)', violates: true },
    { source: "request('/automations?projectId=p1')", violates: true },
    { source: 'callEndpoint(automationsContract.list)', violates: true },
    { source: "request('/automations-legacy')", violates: false },
    { source: "request('/pipelines')", violates: true },
    { source: "request('/pipelines/approvals/pending')", violates: false },
    { source: 'trpcCall(() => trpc.automations.list.query())', violates: false },
    { source: "// request('/automations')", violates: false },
    { source: "import type { AppRouter } from '@funny/api';", violates: false },
    { source: "import { TRPC_PATH } from '@funny/api/path';", violates: false },
    { source: "import { TRPC_PATH, type AppRouter } from '@funny/api';", violates: true },
    { source: "import {\n  TRPC_PATH,\n  type AppRouter,\n} from '@funny/api';", violates: true },
    { source: "import type {\n  AppRouter,\n} from '@funny/api';", violates: false },
    { source: "const api = await import('@funny/api');", violates: true },
    { source: "import '@funny/api';", violates: true },
  ];
  const wrong = [
    ...apiCases.filter(
      ({ source, violates }) => findApiViolations('x.ts', source).length > 0 !== violates,
    ),
    ...clientCases.filter(
      ({ source, violates }) => findClientViolations('x.ts', source).length > 0 !== violates,
    ),
  ];
  if (wrong.length > 0) {
    throw new Error(`trpc-api self-test misclassified: ${JSON.stringify(wrong)}`);
  }
  console.log('trpc-api self-test ok');
}

function scan(dir: string, check: (rel: string, source: string) => string[]): string[] {
  const violations: string[] = [];
  for (const rel of new Bun.Glob('**/*.{ts,tsx}').scanSync(dir)) {
    const path = rel.replaceAll('\\', '/');
    if (isExcluded(path)) continue;
    violations.push(...check(path, readFileSync(join(dir, rel), 'utf8')));
  }
  return violations;
}

if (import.meta.main) {
  if (process.argv.includes('--self-test')) runSelfTest();

  const violations = [
    ...scan(API_SRC, findApiViolations),
    ...scan(CLIENT_SRC, findClientViolations),
  ];
  if (violations.length > 0) {
    console.error('tRPC API violations:\n');
    for (const v of violations) console.error('  ' + v);
    console.error(`\n${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log('trpc api ok — @funny/api is isolated, migrated groups use tRPC');
}
