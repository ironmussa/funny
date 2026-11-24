/**
 * Regression test for issue #452: every type assertion in the smaller packages,
 * scripts, e2e and spikes states its invariant in a `SAFETY:` comment.
 *
 * The lint rule `anti-slop/require-safety-comment-for-type-assertion`
 * (tools/oxlint/anti-slop/rules/) only runs through `bun lint`, which needs a
 * Bun canary build that the test jobs do not have. This test applies the same
 * rule to the same files with the tree-sitter TypeScript grammars that
 * packages/core already ships for symbol extraction:
 *
 * - every `x as T` and `<T>x`, except `as const`, is checked;
 * - a comment counts when it matches `SAFETY: <text>` and sits directly before
 *   the assertion or before any node that encloses it, up to the containing
 *   statement (expression, return, throw, variable declaration, class field;
 *   an `export` in front of that statement counts too);
 * - test files are skipped, as oxlint.config.ts turns the rule off for them.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join, relative } from 'path';

interface SyntaxNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  parent: SyntaxNode | null;
  lastChild: SyntaxNode | null;
  descendantsOfType(types: string[]): SyntaxNode[];
}

interface TreeSitterParser {
  setLanguage(language: unknown): void;
  parse(source: string): { rootNode: SyntaxNode };
}

interface TreeSitterModule {
  init(): Promise<void>;
  Language: { load(path: string): Promise<unknown> };
  new (): TreeSitterParser;
}

const REPO_ROOT = join(import.meta.dir, '..', '..');
// web-tree-sitter and tree-sitter-wasms are dependencies of packages/core.
const requireFromCore = createRequire(join(REPO_ROOT, 'packages/core/package.json'));

/** The scope of issue #452. */
const SCANNED_DIRS = [
  'packages/chrome-extension',
  'packages/memory',
  'packages/evflow',
  'packages/client-gpuix',
  'packages/client-core',
  'packages/client-benchmark',
  'packages/client-gpuix-benchmark',
  'packages/gpuix-ui',
  'packages/pipelines',
  'packages/harness',
  'packages/reviewbot',
  'packages/workflows',
  'packages/sdk',
  'packages/plugin-sdk',
  'packages/ui-contracts',
  'packages/runner-grpc-harness',
  'packages/sandbox',
  'packages/api',
  'scripts',
  'e2e',
  'spikes',
];

/** Directories oxlint never reads (ignorePatterns, build output). */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'target', '.git']);

/** The node kinds the rule stops at: the statement that owns the comment. */
const OWNER_KINDS = new Set([
  'expression_statement',
  'public_field_definition',
  'return_statement',
  'throw_statement',
  'lexical_declaration',
  'variable_declaration',
]);

const SAFETY_PATTERN = /(?:^|[^\p{L}\p{N}_])SAFETY\s*:\s*\S/u;

function isTestFile(path: string): boolean {
  return /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.[cm]?tsx?$/.test(path);
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) files.push(...listSourceFiles(path));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !isTestFile(path)) {
      files.push(path);
    }
  }
  return files;
}

/** The comments directly before `start`, with only whitespace between them. */
function commentsBefore(source: string, comments: SyntaxNode[], start: number): SyntaxNode[] {
  const byEnd = new Map(comments.map((comment) => [comment.endIndex, comment]));
  const found: SyntaxNode[] = [];
  let position = start;
  while (true) {
    while (position > 0 && /\s/.test(source[position - 1])) position--;
    const comment = byEnd.get(position);
    if (!comment) return found;
    found.push(comment);
    position = comment.startIndex;
  }
}

function hasSafetyComment(source: string, comments: SyntaxNode[], assertion: SyntaxNode): boolean {
  const justifies = (owner: SyntaxNode) =>
    commentsBefore(source, comments, owner.startIndex).some(
      (comment) =>
        comment.endIndex <= assertion.startIndex &&
        SAFETY_PATTERN.test(source.slice(comment.startIndex, comment.endIndex)),
    );
  let current = assertion;
  while (true) {
    if (justifies(current)) return true;
    if (OWNER_KINDS.has(current.type)) {
      const parent = current.parent;
      return parent?.type === 'export_statement' && justifies(parent);
    }
    if (!current.parent || current.parent.type === 'program') return false;
    current = current.parent;
  }
}

async function loadParsers(): Promise<{ ts: TreeSitterParser; tsx: TreeSitterParser }> {
  // SAFETY: web-tree-sitter 0.20 exports the Parser class as the module itself
  // (`init`, `Language.load`, `new Parser()`), which is all this test uses.
  const Parser = requireFromCore('web-tree-sitter') as TreeSitterModule;
  await Parser.init();
  const wasmDir = join(dirname(requireFromCore.resolve('tree-sitter-wasms/package.json')), 'out');
  const ts = new Parser();
  ts.setLanguage(await Parser.Language.load(join(wasmDir, 'tree-sitter-typescript.wasm')));
  const tsx = new Parser();
  tsx.setLanguage(await Parser.Language.load(join(wasmDir, 'tree-sitter-tsx.wasm')));
  return { ts, tsx };
}

/** `file:line:column` of every type assertion without a SAFETY comment. */
async function unjustifiedAssertions(): Promise<string[]> {
  const parsers = await loadParsers();
  const missing: string[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of listSourceFiles(join(REPO_ROOT, dir))) {
      const source = readFileSync(file, 'utf8');
      const parser = file.endsWith('.tsx') ? parsers.tsx : parsers.ts;
      const root = parser.parse(source).rootNode;
      const comments = root.descendantsOfType(['comment']);
      for (const assertion of root.descendantsOfType(['as_expression', 'type_assertion'])) {
        if (assertion.type === 'as_expression' && assertion.lastChild?.type === 'const') continue;
        if (hasSafetyComment(source, comments, assertion)) continue;
        const { row, column } = assertion.startPosition;
        missing.push(`${relative(REPO_ROOT, file)}:${row + 1}:${column + 1}`);
      }
    }
  }
  return missing;
}

describe('type assertions in the other packages, scripts, e2e and spikes (#452)', () => {
  test('every non-const assertion has a SAFETY comment before it', async () => {
    expect(await unjustifiedAssertions()).toEqual([]);
  }, 60_000);
});
