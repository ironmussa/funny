#!/usr/bin/env bun
/**
 * Fitness function: server feature-module boundaries (`packages/server/src/modules/<name>/`).
 *
 * Rules:
 *  - `domain/` and `application/` must not import Hono, Drizzle, gRPC, the
 *    server DB layer, concrete server services/routes/middleware, or the
 *    module's own `infrastructure/` or `composition`.
 *  - `domain/` must not import `application/`.
 *  - Code outside a module imports only its public entry point (`index`)
 *    or its production wiring (`composition`).
 *
 * Tests (`__tests__`) are exempt. They exercise internals directly.
 * Exits non-zero on violation. `--self-test` checks the allowed/forbidden fixtures.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SERVER_SRC = 'packages/server/src';
const MODULES_DIR = `${SERVER_SRC}/modules`;

const IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

const INNER_FORBIDDEN: Array<{ name: string; test: (spec: string) => boolean }> = [
  { name: 'hono', test: (s) => s === 'hono' || s.startsWith('hono/') },
  { name: 'drizzle-orm', test: (s) => s === 'drizzle-orm' || s.startsWith('drizzle-orm/') },
  { name: 'grpc', test: (s) => s.startsWith('@grpc/') || /(?:^|\/)grpc(?:\/|$)/.test(s) },
  { name: 'server db', test: (s) => /(?:^|\/)db(?:\/|\.js$|$)/.test(s) },
  {
    name: 'concrete server layer',
    test: (s) => /(?:^|\/)(?:services|routes|middleware|lib)\//.test(s),
  },
  { name: 'module infrastructure', test: (s) => /(?:^|\/)infrastructure(?:\/|$)/.test(s) },
  { name: 'module composition', test: (s) => /(?:^|\/)composition(?:\.js)?$/.test(s) },
];

type Layer = 'domain' | 'application' | 'other';

function layerOf(fileInModule: string): Layer {
  if (fileInModule.startsWith('domain/')) return 'domain';
  if (fileInModule.startsWith('application/')) return 'application';
  return 'other';
}

/** Violations for one import in a file inside module `<name>` at path `fileInModule`. */
export function classifyInner(fileInModule: string, spec: string): string | null {
  const layer = layerOf(fileInModule);
  if (layer === 'other') return null;
  for (const rule of INNER_FORBIDDEN) {
    if (rule.test(spec)) return `${layer} must not import ${rule.name}`;
  }
  if (layer === 'domain' && /(?:^|\/)application\//.test(spec)) {
    return 'domain must not import application';
  }
  return null;
}

/** Violation for an import of a module internal from outside the module. */
export function classifyOuter(spec: string): string | null {
  const match = spec.match(/(?:^|\/)modules\/([^/]+)\/(.+?)(?:\.js|\.ts)?$/);
  if (!match) return null;
  const entry = match[2];
  if (entry === 'index' || entry === 'composition') return null;
  return `import modules/${match[1]} through index or composition, not ${entry}`;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

function importsOf(source: string): Array<{ spec: string; line: number }> {
  const found: Array<{ spec: string; line: number }> = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    found.push({ spec: m[1], line: source.slice(0, m.index).split('\n').length });
  }
  return found;
}

function runSelfTest(): void {
  const innerAllowed: Array<[string, string]> = [
    ['domain/creation-target.ts', 'neverthrow'],
    ['domain/creation-target.ts', './ids.js'],
    ['application/create-thread.ts', '../domain/creation-target.js'],
    ['application/create-thread.ts', './ports.js'],
    ['infrastructure/runner-adapters.ts', '../../../services/runner-forwarding.js'],
    ['composition.ts', './infrastructure/registry-adapters.js'],
  ];
  const innerForbidden: Array<[string, string]> = [
    ['domain/x.ts', 'hono'],
    ['application/x.ts', 'hono/factory'],
    ['application/x.ts', 'drizzle-orm'],
    ['application/x.ts', '@grpc/grpc-js'],
    ['application/x.ts', '../../../services/grpc/session-registry.js'],
    ['application/x.ts', '../../../db/index.js'],
    ['domain/x.ts', '../../../db/schema.js'],
    ['application/x.ts', '../../../services/thread-registry.js'],
    ['application/x.ts', '../../../routes/threads.js'],
    ['application/x.ts', '../infrastructure/runner-adapters.js'],
    ['application/x.ts', '../composition.js'],
    ['domain/x.ts', '../application/ports.js'],
  ];
  const outerAllowed = ['../modules/threads/index.js', '../modules/threads/composition.js'];
  const outerForbidden = [
    '../modules/threads/application/create-thread.js',
    '../modules/threads/infrastructure/runner-adapters.js',
    '../modules/threads/domain/ids.js',
  ];

  for (const [file, spec] of innerAllowed) {
    if (classifyInner(file, spec)) throw new Error(`self-test rejected allowed ${file} → ${spec}`);
  }
  for (const [file, spec] of innerForbidden) {
    if (!classifyInner(file, spec))
      throw new Error(`self-test accepted forbidden ${file} → ${spec}`);
  }
  for (const spec of outerAllowed) {
    if (classifyOuter(spec)) throw new Error(`self-test rejected allowed outer import ${spec}`);
  }
  for (const spec of outerForbidden) {
    if (!classifyOuter(spec)) throw new Error(`self-test accepted forbidden outer import ${spec}`);
  }
  console.log(
    'module-boundaries self-test ok — allowed and forbidden fixtures classified correctly',
  );
}

if (import.meta.main) {
  if (process.argv.includes('--self-test')) runSelfTest();

  const violations: string[] = [];
  const modulesAbs = join(ROOT, MODULES_DIR);

  if (existsSync(modulesAbs)) {
    for (const file of walk(join(ROOT, SERVER_SRC))) {
      const rel = relative(ROOT, file);
      const source = readFileSync(file, 'utf8');
      const insideModule = rel.startsWith(`${MODULES_DIR}/`)
        ? rel.slice(MODULES_DIR.length + 1).split('/')
        : null;
      for (const { spec, line } of importsOf(source)) {
        const reason = insideModule
          ? classifyInner(insideModule.slice(1).join('/'), spec)
          : classifyOuter(spec);
        if (reason) violations.push(`[${reason}] ${rel}:${line}  ${spec}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error('Module boundary violations:\n');
    for (const v of violations) console.error('  ' + v);
    console.error(`\n${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log('module boundaries ok — server feature modules respect their layering');
}
