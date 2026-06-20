#!/usr/bin/env bun
// Fitness function: typed HTTP query parameter validation baseline diff.
//
// Flags new Hono `c.req.query()` reads only when the route coerces or casts the
// value into a typed shape such as number, boolean, enum, or list. Plain string
// query reads stay out of scope to keep this check low-noise.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const BASELINE_PATH = join(ROOT, '.fitness', 'query-boundary-validation-baseline.txt');
const REFRESH = process.argv.includes('--refresh');
const SELF_TEST = process.argv.includes('--self-test');

const ROUTE_ROOTS = ['packages/server/src/routes', 'packages/runtime/src/routes'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const LOOKAHEAD_LINES = 8;

interface Violation {
  file: string;
  line: number;
  occurrence: number;
  snippet: string;
  reason: string;
}

interface CheckOptions {
  root: string;
  routeRoots: string[];
  baselinePath: string;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).sort();
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    const ext = path.slice(path.lastIndexOf('.'));
    if (SOURCE_EXTENSIONS.has(ext)) files.push(path);
  }
  return files;
}

function normalizeSnippet(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function assignmentName(line: string): string | null {
  const match = line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
  return match?.[1] ?? null;
}

function typedInlineQuery(line: string): string | null {
  if (
    /\b(?:Number|parseInt|parseFloat|Number\.parseInt|Number\.parseFloat)\s*\([^)]*\bc\.req\.query\s*\(/.test(
      line,
    )
  ) {
    return 'query parameter coerced to number without parseQuery';
  }
  if (/\bc\.req\.query\s*\([^)]*\)\s*(?:={2,3}|!={1,2})\s*['"](?:true|false)['"]/.test(line)) {
    return 'query parameter coerced to boolean without parseQuery';
  }
  if (/\bc\.req\.query\s*\([^)]*\)\s+as\s+[^;]+/.test(line)) {
    return 'query parameter cast without parseQuery';
  }
  return null;
}

function typedUseNear(lines: string[], startIndex: number, variableName: string): string | null {
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const window = lines.slice(startIndex, startIndex + LOOKAHEAD_LINES + 1).join('\n');
  if (
    new RegExp(
      `\\b(?:Number|parseInt|parseFloat|Number\\.parseInt|Number\\.parseFloat)\\s*\\(\\s*${escaped}\\b`,
    ).test(window)
  ) {
    return 'query parameter coerced to number without parseQuery';
  }
  if (new RegExp(`\\b${escaped}\\s*(?:={2,3}|!={1,2})\\s*['"](?:true|false)['"]`).test(window)) {
    return 'query parameter coerced to boolean without parseQuery';
  }
  if (new RegExp(`\\b${escaped}\\.split\\s*\\(`).test(window)) {
    return 'query parameter coerced to list without parseQuery';
  }
  return null;
}

function checkFile(absFile: string, root: string): Violation[] {
  const relFile = relative(root, absFile);
  const lines = readFileSync(absFile, 'utf-8').split('\n');
  const violations: Violation[] = [];
  const occurrenceCounts = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\bc\.req\.query\s*\(/.test(line)) continue;

    const reason =
      typedInlineQuery(line) ??
      (() => {
        const variableName = assignmentName(line);
        return variableName ? typedUseNear(lines, i, variableName) : null;
      })();
    if (!reason) continue;

    const snippet = normalizeSnippet(line);
    const occurrenceKey = `${relFile}\t${snippet}\t${reason}`;
    const occurrence = (occurrenceCounts.get(occurrenceKey) ?? 0) + 1;
    occurrenceCounts.set(occurrenceKey, occurrence);
    violations.push({ file: relFile, line: i + 1, occurrence, snippet, reason });
  }

  return violations;
}

function violationKey(v: Violation): string {
  return `${v.file}\t#${v.occurrence}\t${v.snippet}\t${v.reason}`;
}

function collectViolations(opts: Pick<CheckOptions, 'root' | 'routeRoots'>): Violation[] {
  const files = opts.routeRoots.flatMap((dir) => walk(join(opts.root, dir)));
  return files.flatMap((file) => checkFile(file, opts.root));
}

function loadBaseline(baselinePath: string): Set<string> {
  if (!existsSync(baselinePath)) return new Set();
  return new Set(
    readFileSync(baselinePath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#')),
  );
}

function writeBaseline(violations: Violation[], baselinePath: string): void {
  mkdirSync(dirname(baselinePath), { recursive: true });
  const sorted = violations.map(violationKey).sort();
  const header =
    '# query boundary validation baseline - generated by `bun run fitness:query-validation:refresh`\n' +
    '# Each line: <file>\\t<occurrence>\\t<normalized source line>\\t<reason>\n' +
    '# Scope: typed Hono `c.req.query()` reads in packages/server/src/routes and packages/runtime/src/routes.\n' +
    `# Last refreshed: ${new Date().toISOString()}\n` +
    `# Total violations: ${sorted.length}\n\n`;
  writeFileSync(baselinePath, header + sorted.join('\n') + '\n');
}

function findNewViolations(violations: Violation[], baseline: Set<string>): Violation[] {
  return violations.filter((v) => !baseline.has(violationKey(v)));
}

function runCheck(opts: CheckOptions): number {
  const violations = collectViolations(opts);

  if (REFRESH) {
    writeBaseline(violations, opts.baselinePath);
    console.log(`✓ Query validation baseline refreshed: ${violations.length} violation(s) frozen`);
    console.log(`  ${opts.baselinePath}`);
    return 0;
  }

  const baseline = loadBaseline(opts.baselinePath);
  const newViolations = findNewViolations(violations, baseline);
  if (newViolations.length === 0) {
    console.log(
      `✓ No new unvalidated typed query reads (baseline: ${baseline.size}, current: ${violations.length})`,
    );
    return 0;
  }

  console.error(`\n✗ ${newViolations.length} new unvalidated typed query read(s):\n`);
  for (const violation of newViolations) {
    console.error(`  ${violation.file}:${violation.line}`);
    console.error(`    ${violation.reason}`);
    console.error(`    ${violation.snippet}`);
  }
  console.error(
    '\n  Validate typed query parameters with parseQuery(c, schema). If this is intentional debt, refresh the baseline:\n    bun run fitness:query-validation:refresh\n',
  );
  return 1;
}

function writeRoute(root: string, name: string, source: string): void {
  const routesDir = join(root, 'packages', 'server', 'src', 'routes');
  mkdirSync(routesDir, { recursive: true });
  writeFileSync(join(routesDir, name), source.trimStart());
}

function runSelfTest(): void {
  const root = mkdtempSync(join(tmpdir(), 'funny-query-boundary-validation-'));
  try {
    writeRoute(
      root,
      'strings.ts',
      `
      route.get('/strings', (c) => {
        const q = c.req.query('q') ?? '';
        return c.json({ q });
      });
      `,
    );
    writeRoute(
      root,
      'typed.ts',
      `
      route.get('/typed', (c) => {
        const limit = Number(c.req.query('limit') ?? 10);
        const enabled = c.req.query('enabled') === 'true';
        const kind = c.req.query('kind') as 'open' | 'closed' | undefined;
        const raw = c.req.query('labels') ?? '';
        const labels = raw.split(',');
        return c.json({ limit, enabled, kind, labels });
      });
      `,
    );

    const opts = {
      root,
      routeRoots: ROUTE_ROOTS,
      baselinePath: join(root, '.fitness', 'query-boundary-validation-baseline.txt'),
    };
    const violations = collectViolations(opts);
    const keys = violations.map(violationKey).sort();
    assert.equal(violations.length, 4);
    assert(!keys.some((key) => key.includes('strings.ts')));
    assert(keys.some((key) => key.includes('coerced to number')));
    assert(keys.some((key) => key.includes('coerced to boolean')));
    assert(keys.some((key) => key.includes('cast without parseQuery')));
    assert(keys.some((key) => key.includes('coerced to list')));

    writeBaseline(violations, opts.baselinePath);
    assert.equal(runCheck(opts), 0);

    writeRoute(
      root,
      'new-debt.ts',
      `
      route.get('/new-debt', (c) => {
        const page = parseInt(c.req.query('page') || '1', 10);
        return c.json({ page });
      });
      `,
    );
    const newViolations = findNewViolations(
      collectViolations(opts),
      loadBaseline(opts.baselinePath),
    );
    assert.equal(newViolations.length, 1);
    assert.equal(newViolations[0]?.file, 'packages/server/src/routes/new-debt.ts');
    console.log('✓ Query boundary validation self-test passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(): void {
  if (SELF_TEST) {
    runSelfTest();
    return;
  }

  const exitCode = runCheck({
    root: ROOT,
    routeRoots: ROUTE_ROOTS,
    baselinePath: BASELINE_PATH,
  });
  if (exitCode !== 0) process.exit(exitCode);
}

main();
