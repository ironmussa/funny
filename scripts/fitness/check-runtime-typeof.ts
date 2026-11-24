#!/usr/bin/env bun
/**
 * Fitness function: no `anti-slop/no-runtime-typeof` finding under the given
 * directories (issue #459 cleared it in packages/server and packages/runtime).
 *
 * Runs the vendored rule itself (tools/oxlint/anti-slop/rules/no-runtime-typeof.ts)
 * with the option oxlint.config.ts gives it (`allowInTypeGuards: true`) over
 * the ESTree oxc-parser produces, the AST oxlint hands its JS plugins. It does
 * not need `bun lint`, which only Bun canary has, so the package test suites
 * can call it on the pinned Bun of CI. Test files are skipped, as the config
 * turns the rule off for them.
 *
 *   bun scripts/fitness/check-runtime-typeof.ts packages/server/src [...]
 *   bun scripts/fitness/check-runtime-typeof.ts --self-test
 *
 * Prints one `file:line:col` per finding and exits 1 when there is any.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parseSync } from 'oxc-parser';

import { noRuntimeTypeofRule } from '../../tools/oxlint/anti-slop/rules/no-runtime-typeof.ts';

const ROOT = join(import.meta.dir, '..', '..');
const RULE_OPTIONS = [{ allowInTypeGuards: true }];
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\./;

interface AstNode {
  type: string;
  start: number;
  parent?: AstNode | null;
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && 'type' in value && 'start' in value;
}

/** Offsets of the `typeof` expressions the rule reports in `source`. */
function findRuntimeTypeof(fileName: string, source: string): number[] {
  const { program, errors } = parseSync(fileName, source);
  if (errors.length > 0) throw new Error(`${fileName}: ${errors[0].message}`);
  if (!isAstNode(program)) throw new Error(`${fileName}: the parser returned no program`);
  const reported: number[] = [];
  // SAFETY: the rule reads only `context.options` and calls `context.report({ node })`
  // (tools/oxlint/anti-slop/rules/no-runtime-typeof.ts); this object provides both.
  const context = {
    options: RULE_OPTIONS,
    report: ({ node }: { node: AstNode }) => reported.push(node.start),
  } as never;
  const onUnary = noRuntimeTypeofRule.createOnce(context).UnaryExpression;
  if (!onUnary) throw new Error('no-runtime-typeof has no UnaryExpression visitor');

  const walk = (node: AstNode, parent: AstNode | null) => {
    node.parent = parent;
    if (node.type === 'UnaryExpression') {
      // SAFETY: oxc-parser builds the ESTree oxlint gives its JS plugins, and `walk`
      // set `parent` on this node and every ancestor, which is all the rule reads.
      onUnary(node as never);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'parent') continue;
      const children = Array.isArray(child) ? child : [child];
      for (const item of children) if (isAstNode(item)) walk(item, node);
    }
  };
  walk(program, null);
  return reported;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => SOURCE_FILE.test(path) && !path.endsWith('.d.ts'))
    .map((path) => join(dir, path))
    .filter((path) => !TEST_FILE.test(relative(ROOT, path)) && !path.includes('node_modules'));
}

function lineAndColumn(source: string, offset: number): string {
  const before = source.slice(0, offset).split('\n');
  return `${before.length}:${before[before.length - 1].length + 1}`;
}

function selfTest(): void {
  const cases: Array<[string, number]> = [
    ['const a = (v: unknown) => typeof v === "string";', 1],
    ['function g(v: unknown): v is string { return typeof v === "string"; }', 0],
    ['const ok = typeof window === "undefined";', 0],
    ['function g(v: unknown): v is string { return [v].some((x) => typeof x === "string"); }', 1],
    ['type T = typeof import("x");', 0],
  ];
  for (const [source, expected] of cases) {
    const found = findRuntimeTypeof('fixture.ts', source).length;
    if (found !== expected) {
      console.error(`self-test: expected ${expected}, found ${found}: ${source}`);
      process.exit(1);
    }
  }
  console.log(`self-test: ${cases.length} fixtures ok`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
  } else {
    if (args.length === 0) {
      console.error('usage: check-runtime-typeof.ts <dir> [...] | --self-test');
      process.exit(2);
    }
    const findings: string[] = [];
    for (const dir of args) {
      for (const path of sourceFiles(join(ROOT, dir))) {
        const source = readFileSync(path, 'utf8');
        for (const offset of findRuntimeTypeof(path, source)) {
          findings.push(
            `${relative(ROOT, path)}:${lineAndColumn(source, offset)}: no-runtime-typeof`,
          );
        }
      }
    }
    for (const finding of findings) console.log(finding);
    console.log(`${findings.length} no-runtime-typeof finding(s) in ${args.join(', ')}`);
    process.exit(findings.length > 0 ? 1 : 0);
  }
}
