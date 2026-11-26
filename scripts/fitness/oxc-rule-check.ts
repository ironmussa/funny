/**
 * Shared by the fitness checks that run one vendored anti-slop rule
 * (tools/oxlint/anti-slop/rules/*) without `bun lint`, which only Bun canary
 * has: they parse with oxc-parser, which builds the ESTree oxlint hands its JS
 * plugins, walk it, and report every node the rule reports. Used by
 * check-runtime-typeof.ts and check-unknown-parameters.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parseSync } from 'oxc-parser';

const ROOT = join(import.meta.dir, '..', '..');
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
// oxlint.config.ts turns the anti-slop rules off for test files.
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\./;

export interface AstNode {
  type: string;
  start: number;
  end: number;
  parent?: AstNode | null;
}

/** One node a rule reported, with the text to print after its rule name. */
export interface RuleFinding {
  offset: number;
  detail?: string;
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && 'type' in value && 'start' in value;
}

/** The AST nodes directly under `node` (its parent link excluded). */
function childNodes(node: AstNode): AstNode[] {
  return Object.entries(node)
    .filter(([key]) => key !== 'parent')
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter(isAstNode);
}

/**
 * Parse `source` and call `visit` on every node, parents before children,
 * with `parent` set on each node and its ancestors.
 */
export function walkProgram(
  fileName: string,
  source: string,
  visit: (node: AstNode) => void,
): void {
  const { program, errors } = parseSync(fileName, source);
  if (errors.length > 0) throw new Error(`${fileName}: ${errors[0].message}`);
  if (!isAstNode(program)) throw new Error(`${fileName}: the parser returned no program`);
  const walk = (node: AstNode, parent: AstNode | null) => {
    node.parent = parent;
    visit(node);
    for (const child of childNodes(node)) walk(child, node);
  };
  walk(program, null);
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

type FindRule = (fileName: string, source: string) => RuleFinding[];

/** Exit 1 at the first fixture whose finding count is not the expected one. */
function runSelfTest(find: FindRule, fixtures: Array<[string, number]>): void {
  const failed = fixtures.find(
    ([source, expected]) => find('fixture.ts', source).length !== expected,
  );
  if (failed) {
    const [source, expected] = failed;
    console.error(
      `self-test: expected ${expected}, found ${find('fixture.ts', source).length}: ${source}`,
    );
    process.exit(1);
  }
  console.log(`self-test: ${fixtures.length} fixtures ok`);
}

/** One `file:line:col: <rule>[ (detail)]` line per finding in the source files under `dirs`. */
function scan(rule: string, find: FindRule, dirs: string[]): string[] {
  return dirs.flatMap((dir) =>
    sourceFiles(join(ROOT, dir)).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return find(path, source).map(({ offset, detail }) => {
        const suffix = detail ? ` (${detail})` : '';
        return `${relative(ROOT, path)}:${lineAndColumn(source, offset)}: ${rule}${suffix}`;
      });
    }),
  );
}

/**
 * The command line of a rule check: `--self-test` runs `fixtures` (source and
 * expected finding count); otherwise every directory argument is scanned, one
 * line printed per finding, and the process exits 1 when there is any.
 */
export function runRuleCheck(
  rule: string,
  find: FindRule,
  fixtures: Array<[string, number]>,
): void {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return runSelfTest(find, fixtures);
  if (args.length === 0) {
    console.error(`usage: ${relative(ROOT, process.argv[1] ?? '')} <dir> [...] | --self-test`);
    process.exit(2);
  }
  const findings = scan(rule, find, args);
  for (const finding of findings) console.log(finding);
  console.log(`${findings.length} ${rule} finding(s) in ${args.join(', ')}`);
  process.exit(findings.length > 0 ? 1 : 0);
}
