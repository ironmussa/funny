/**
 * Regression test for issue #518: no `anti-slop/no-known-value-widening`
 * finding in packages/runtime/src.
 *
 * The rule (tools/oxlint/anti-slop/rules/no-known-value-widening.ts) only runs
 * through `bun lint`, which needs a Bun canary build that the test job does not
 * have. This test runs the same vendored rule over the ESTree oxc-parser
 * produces (the AST oxlint hands its JS plugins), with a small scope model in
 * place of oxlint's: the rule only asks which declaration an identifier
 * resolves to, and whether that `const` binding is reassigned, which a `const`
 * never is. Test files are skipped, as oxlint.config.ts turns the rule off for
 * them.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

import { parseSync, visitorKeys } from 'oxc-parser';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');
// Loaded by path so the runtime typecheck does not take in tools/ (another rootDir).
const RULE_PATH = join(
  REPO_ROOT,
  'tools',
  'oxlint',
  'anti-slop',
  'rules',
  'no-known-value-widening.ts',
);
const RUNTIME_SRC = join(REPO_ROOT, 'packages', 'runtime', 'src');
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\./;
// The check parses every source file of the package; under the parallel suite
// that can take longer than the default per-test timeout.
const LINT_TIMEOUT_MS = 120_000;

interface AstNode {
  type: string;
  start: number;
  parent?: AstNode | null;
  [key: string]: unknown;
}

interface Definition {
  type: string;
  node: AstNode;
}

interface Variable {
  name: string;
  defs: Definition[];
  references: never[];
}

interface Scope {
  set: Map<string, Variable>;
  upper: Scope | null;
}

type Visitors = Record<string, ((node: AstNode) => void) | undefined>;

interface WideningRuleModule {
  noKnownValueWideningRule: { createOnce(context: never): Visitors };
}

// SAFETY: the module at RULE_PATH exports `noKnownValueWideningRule`, an oxlint
// `defineRule` result whose `createOnce` returns its visitors by node type.
const { noKnownValueWideningRule } = (await import(RULE_PATH)) as WideningRuleModule;

const SCOPE_NODES = new Set([
  'Program',
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'BlockStatement',
  'StaticBlock',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'SwitchStatement',
  'CatchClause',
  'TSModuleBlock',
]);
const FUNCTION_NODES = new Set([
  'Program',
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

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

/** The binding identifiers a declaration pattern introduces. */
function patternIdentifiers(pattern: AstNode | null | undefined): AstNode[] {
  if (!pattern) return [];
  switch (pattern.type) {
    case 'Identifier':
      return [pattern];
    case 'AssignmentPattern':
      return patternIdentifiers(pattern.left as AstNode);
    case 'RestElement':
      return patternIdentifiers(pattern.argument as AstNode);
    case 'TSParameterProperty':
      return patternIdentifiers(pattern.parameter as AstNode);
    case 'ArrayPattern':
      return (pattern.elements as (AstNode | null)[]).flatMap(patternIdentifiers);
    case 'ObjectPattern':
      return (pattern.properties as AstNode[]).flatMap((property) =>
        property.type === 'RestElement'
          ? patternIdentifiers(property)
          : patternIdentifiers(property.value as AstNode),
      );
    default:
      return [];
  }
}

/** Runs the rule on one file; returns the offsets it reports. */
function findWidening(fileName: string, source: string): number[] {
  const { program, errors } = parseSync(fileName, source);
  if (errors.length > 0) throw new Error(`${fileName}: ${errors[0].message}`);
  if (!isAstNode(program)) throw new Error(`${fileName}: the parser returned no program`);

  const scopes = new Map<AstNode, Scope>();
  const nodes: AstNode[] = [];
  const link = (node: AstNode, parent: AstNode | null, upper: Scope | null) => {
    node.parent = parent;
    nodes.push(node);
    let scope = upper;
    if (SCOPE_NODES.has(node.type)) {
      scope = { set: new Map(), upper };
      scopes.set(node, scope);
    }
    for (const child of childNodes(node)) link(child, node, scope);
  };
  link(program, null, null);

  const scopeNodeOf = (node: AstNode, functionOnly = false): AstNode => {
    let current = node.parent ?? null;
    while (current && !(functionOnly ? FUNCTION_NODES : SCOPE_NODES).has(current.type)) {
      current = current.parent ?? null;
    }
    return current ?? program;
  };
  const declare = (scopeNode: AstNode, identifier: AstNode, def: Definition) => {
    const scope = scopes.get(scopeNode);
    if (!scope) return;
    const name = identifier.name as string;
    const variable = scope.set.get(name) ?? { name, defs: [], references: [] };
    variable.defs.push(def);
    scope.set.set(name, variable);
  };

  for (const node of nodes) {
    switch (node.type) {
      case 'VariableDeclaration': {
        const scopeNode = scopeNodeOf(node, node.kind === 'var');
        for (const declarator of node.declarations as AstNode[]) {
          for (const id of patternIdentifiers(declarator.id as AstNode)) {
            declare(scopeNode, id, { type: 'Variable', node: declarator });
          }
        }
        break;
      }
      case 'FunctionDeclaration':
      case 'TSDeclareFunction':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const id = node.id as AstNode | null | undefined;
        if (id && node.type !== 'FunctionExpression') {
          declare(scopeNodeOf(node), id, { type: 'FunctionName', node });
        } else if (id) {
          declare(node, id, { type: 'FunctionName', node });
        }
        for (const param of node.params as AstNode[]) {
          for (const paramId of patternIdentifiers(param)) {
            declare(node, paramId, { type: 'Parameter', node });
          }
        }
        break;
      }
      case 'ClassDeclaration':
      case 'TSEnumDeclaration':
        if (node.id) {
          declare(scopeNodeOf(node), node.id as AstNode, { type: 'ClassName', node });
        }
        break;
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        declare(program, node.local as AstNode, { type: 'ImportBinding', node });
        break;
      case 'CatchClause':
        for (const id of patternIdentifiers(node.param as AstNode | null)) {
          declare(node, id, { type: 'CatchClause', node });
        }
        break;
    }
  }

  const reported: number[] = [];
  const sourceCode = {
    visitorKeys,
    getText: (node: AstNode & { end: number }) => source.slice(node.start, node.end),
    getScope: (node: AstNode): Scope => {
      let current: AstNode | null = node;
      while (current && !scopes.has(current)) current = current.parent ?? null;
      return scopes.get(current ?? program)!;
    },
  };
  // SAFETY: the rule reads only `context.sourceCode` (visitorKeys, getText and
  // getScope, whose scopes carry `set` / `upper` and variables `defs` /
  // `references`) and calls `context.report({ node })`; this object provides them.
  const context = {
    sourceCode,
    report: ({ node }: { node: AstNode }) => reported.push(node.start),
  } as never;
  const visitors = noKnownValueWideningRule.createOnce(context);
  for (const node of nodes) visitors[node.type]?.(node);
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

describe('no-known-value-widening in packages/runtime', () => {
  test('the harness reports what the rule reports', () => {
    const cases: Array<[string, number]> = [
      // An open dictionary annotation on a literal.
      ['const a: Record<string, string> = { x: "1" };', 1],
      // An anonymous object return type on a literal return.
      ['function f(): { a: number } { return { a: 1 }; }', 1],
      // ...also through a const binding.
      ['function f(): { a: number } { const v = { a: 1 }; return v; }', 1],
      // A named contract keeps the evidence.
      ['interface T { [k: string]: string } const a: T = { x: "1" };', 0],
      ['interface A { a: number } function f(): A { return { a: 1 }; }', 0],
      // Inference and `satisfies`.
      ['const a = { x: "1" } satisfies Record<string, string>;', 0],
      // An empty dictionary accumulator is allowed.
      ['const a: Record<string, string> = {};', 0],
      // A parameter is not known evidence.
      ['function f(p: { a: number }): { a: number } { return p; }', 0],
    ];
    for (const [source, expected] of cases) {
      expect({ source, found: findWidening('fixture.ts', source).length }).toEqual({
        source,
        found: expected,
      });
    }
  });

  test(
    'the rule reports no widened known value',
    () => {
      const findings: string[] = [];
      for (const path of sourceFiles(RUNTIME_SRC)) {
        const source = readFileSync(path, 'utf8');
        for (const offset of findWidening(path, source)) {
          findings.push(`${relative(REPO_ROOT, path)}:${lineAndColumn(source, offset)}`);
        }
      }
      expect(findings).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
