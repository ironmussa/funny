/**
 * Keeps the server modules split in #491 within the size limits of
 * `oxlint.config.ts` (`max-lines`: 800, `max-lines-per-function`: 250, both
 * skipping blank and comment lines), so the split cannot silently grow back.
 * The test job's Bun has no `bun lint`, so the lines are counted here.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', '..');
const MAX_FILE_LINES = 800;
const MAX_FUNCTION_LINES = 250;

/** The source with comments blanked out and string contents replaced, newlines kept. */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const templateDepth: number[] = [];
  let braceDepth = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      out += 'S';
      i++;
      while (i < source.length && source[i] !== ch && source[i] !== '\n') {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '`' || (ch === '}' && templateDepth.at(-1) === braceDepth)) {
      if (ch === '}') templateDepth.pop();
      else out += 'T';
      i++;
      let opensExpression = false;
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          templateDepth.push(braceDepth);
          i += 2;
          opensExpression = true;
          break;
        }
        // A template line is code, like the rule counts it.
        out += source[i] === '\n' ? '\nT' : '';
        i++;
      }
      // Skip the closing backtick only: after `${` the next one opens a nested template.
      if (!opensExpression && source[i] === '`') i++;
      continue;
    }
    if (ch === '{') braceDepth++;
    if (ch === '}') braceDepth--;
    out += ch;
    i++;
  }
  return out;
}

function codeLines(stripped: string): number {
  return stripped.split('\n').filter((line) => line.trim() !== '').length;
}

/** Counted lines of the function whose declaration matches `signature`. */
function functionLines(stripped: string, signature: RegExp): number {
  const match = signature.exec(stripped);
  if (!match) throw new Error(`function not found: ${signature}`);
  let i = stripped.indexOf('(', match.index);
  for (let parens = 0; i < stripped.length; i++) {
    if (stripped[i] === '(') parens++;
    if (stripped[i] === ')' && --parens === 0) break;
  }
  i = stripped.indexOf('{', i);
  let end = i;
  for (let braces = 0; end < stripped.length; end++) {
    if (stripped[end] === '{') braces++;
    if (stripped[end] === '}' && --braces === 0) break;
  }
  const start = stripped.lastIndexOf('\n', match.index) + 1;
  return codeLines(stripped.slice(start, end + 1));
}

function read(path: string): string {
  return stripComments(readFileSync(join(SRC, path), 'utf8'));
}

const FILES_IN_SCOPE = [
  'services/factory/factory-action-provider.ts',
  'services/factory/factory-flow-runs.ts',
  'services/factory/factory-runs.ts',
  'services/factory/factory-watcher.ts',
  'services/factory/factory-batch-leader.ts',
  'services/factory/factory-pull-requests.ts',
  'services/factory/factory-queue.ts',
  'services/factory/factory-sentinel.ts',
  'services/thread-sandboxes/thread-sandbox-service.ts',
  'trpc/ports/factory.ts',
];

/** The modules split out of the files in scope (none before the split). */
const SPLIT_OUT = [
  ...new Bun.Glob(
    'services/factory/{factory-action-provider,factory-flow-runs,factory-runs,factory-watcher,factory-batch-leader,factory-pull-requests,factory-queue,factory-sentinel}-*.ts',
  ).scanSync(SRC),
  ...new Bun.Glob('services/factory/factory-action-provider/*.ts').scanSync(SRC),
  ...new Bun.Glob('services/thread-sandboxes/thread-sandbox-service-*.ts').scanSync(SRC),
  ...new Bun.Glob('trpc/ports/factory-port-*.ts').scanSync(SRC),
];

describe('server module size limits (#491)', () => {
  test('the comment stripper counts code lines like the rule', () => {
    const sample = [
      '// comment',
      '/* block',
      '   comment */',
      '',
      "const a = '// not a comment';",
      'const b = `line one',
      'line two ${a} // still template`;',
      'function f() { return { x: 1 }; } /* tail */',
    ].join('\n');
    expect(codeLines(stripComments(sample))).toBe(4);
    expect(functionLines(stripComments(sample), /function f\(/)).toBe(1);
  });

  test('a template nested in a template expression does not swallow the code after it', () => {
    const sample = ['const a = sql`x(${`f:${id}`})`;', 'function g() {', '  return 1;', '}'].join(
      '\n',
    );
    expect(codeLines(stripComments(sample))).toBe(4);
    expect(functionLines(stripComments(sample), /function g\(/)).toBe(3);
  });

  test.each([...FILES_IN_SCOPE, ...SPLIT_OUT])('%s stays within max-lines', (path) => {
    expect(codeLines(read(path))).toBeLessThanOrEqual(MAX_FILE_LINES);
  });

  test.each([
    [
      'services/factory/factory-action-provider.ts',
      /export function createFactoryActionProvider\(/,
    ],
    ['services/factory/factory-batch-leader.ts', /export function createBatchLeader\(/],
    ['services/factory/factory-flow-runs.ts', /export function createFactoryFlowRuns\(/],
    ['services/factory/factory-pull-requests.ts', /export function createFactoryPullRequests\(/],
    ['services/factory/factory-queue.ts', /export function createFactoryQueue\(/],
    ['services/factory/factory-runs.ts', /export function createFactoryRunsRepository\(/],
    ['services/factory/factory-sentinel.ts', /export function createFactorySentinel\(/],
    [
      'services/thread-sandboxes/thread-sandbox-service.ts',
      /export function createThreadSandboxService\(/,
    ],
    ['trpc/ports/factory.ts', /function createFactoryParts\(/],
  ])('%s: %s stays within max-lines-per-function', (path, signature) => {
    expect(functionLines(read(path), signature)).toBeLessThanOrEqual(MAX_FUNCTION_LINES);
  });

  test('the split-out modules are found', () => {
    expect(SPLIT_OUT.length).toBeGreaterThan(0);
  });
});
