/**
 * Regression test for issue #536 (part 1/5 of #462): no
 * `anti-slop/no-unknown-parameters` and no `anti-slop/no-unknown-returns`
 * finding in packages/client-gpuix/src.
 *
 * The rules (tools/oxlint/anti-slop/rules/no-unknown-{parameters,returns}.ts)
 * only run through `bun lint`, which needs a Bun canary build that the test job
 * does not have. This test runs the same vendored rules over the ESTree
 * oxc-parser produces (the AST oxlint hands its JS plugins). Neither rule reads
 * scopes: they only need the visitor keys and the source text. Test files are
 * skipped, as oxlint.config.ts turns both rules off for them.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

import { parseSync, visitorKeys } from 'oxc-parser';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const RULES_DIR = join(REPO_ROOT, 'tools', 'oxlint', 'anti-slop', 'rules');
const PACKAGE_SRC = join(REPO_ROOT, 'packages', 'client-gpuix', 'src');
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\./;
// The check parses every source file of the package; under the parallel suite
// that can take longer than the default per-test timeout.
const LINT_TIMEOUT_MS = 120_000;

interface AstNode {
  type: string;
  start: number;
  end: number;
  parent?: AstNode | null;
  [key: string]: unknown;
}

type Visitors = Record<string, ((node: AstNode) => void) | undefined>;

interface RuleModule {
  createOnce(context: never): Visitors;
}

// Loaded by path so the package typecheck does not take in tools/ (another rootDir).
// SAFETY: each module exports its rule, an oxlint `defineRule` result whose
// `createOnce` returns its visitors by node type.
const { noUnknownParametersRule } = (await import(join(RULES_DIR, 'no-unknown-parameters.ts'))) as {
  noUnknownParametersRule: RuleModule;
};
// SAFETY: as above.
const { noUnknownReturnsRule } = (await import(join(RULES_DIR, 'no-unknown-returns.ts'))) as {
  noUnknownReturnsRule: RuleModule;
};

const RULES: Array<[string, RuleModule]> = [
  ['no-unknown-parameters', noUnknownParametersRule],
  ['no-unknown-returns', noUnknownReturnsRule],
];

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && 'type' in value && 'start' in value;
}

/** The AST nodes directly under `node`, in source order (its parent link excluded). */
function childNodes(node: AstNode): AstNode[] {
  return Object.entries(node)
    .filter(([key]) => key !== 'parent')
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter(isAstNode);
}

/** Runs both rules on one file; returns `rule@offset` for each report. */
function findUnknownContracts(fileName: string, source: string): Array<[string, number]> {
  const { program, errors } = parseSync(fileName, source);
  if (errors.length > 0) throw new Error(`${fileName}: ${errors[0].message}`);
  if (!isAstNode(program)) throw new Error(`${fileName}: the parser returned no program`);

  const nodes: AstNode[] = [];
  const link = (node: AstNode, parent: AstNode | null) => {
    node.parent = parent;
    nodes.push(node);
    for (const child of childNodes(node)) link(child, node);
  };
  link(program, null);

  const reported: Array<[string, number]> = [];
  for (const [name, rule] of RULES) {
    // SAFETY: the rules read only `context.sourceCode` (visitorKeys, getText)
    // and call `context.report({ node })`; this object provides them.
    const context = {
      sourceCode: {
        visitorKeys,
        getText: (node: AstNode) => source.slice(node.start, node.end),
      },
      report: ({ node }: { node: AstNode }) => reported.push([name, node.start]),
    } as never;
    const visitors = rule.createOnce(context);
    for (const node of nodes) visitors[node.type]?.(node);
  }
  return reported;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => SOURCE_FILE.test(path) && !path.endsWith('.d.ts'))
    .map((path) => join(dir, path))
    .filter((path) => !TEST_FILE.test(relative(REPO_ROOT, path)));
}

function lineAndColumn(source: string, offset: number): string {
  const before = source.slice(0, offset).split('\n');
  return `${before.length}:${before[before.length - 1].length + 1}`;
}

describe('no-unknown-parameters and no-unknown-returns in packages/client-gpuix', () => {
  test('the harness reports what the rules report', () => {
    const cases: Array<[string, string[]]> = [
      ['function f(value: unknown): string { return ""; }', ['no-unknown-parameters']],
      ['function f(value: string): unknown { return value; }', ['no-unknown-returns']],
      ['async function f(): Promise<unknown> { return 1; }', ['no-unknown-returns']],
      // A generic, a named type, an error cause and a type-predicate subject pass.
      ['function f<Value>(value: Value): string { return ""; }', []],
      ['function f(value: string): number { return 1; }', []],
      ['function f(cause: unknown): string { return ""; }', []],
      ['function f(value: unknown): value is string { return true; }', []],
    ];
    for (const [source, expected] of cases) {
      const found = findUnknownContracts('fixture.ts', source).map(([rule]) => rule);
      expect({ source, found }).toEqual({ source, found: expected });
    }
  });

  test(
    'the rules report no unknown parameter or return',
    () => {
      const findings: string[] = [];
      for (const path of sourceFiles(PACKAGE_SRC)) {
        const source = readFileSync(path, 'utf8');
        for (const [rule, offset] of findUnknownContracts(path, source)) {
          findings.push(`${relative(REPO_ROOT, path)}:${lineAndColumn(source, offset)} ${rule}`);
        }
      }
      expect(findings).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
