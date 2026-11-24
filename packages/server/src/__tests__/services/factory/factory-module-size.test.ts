/**
 * Keeps the factory services, the thread sandbox service and the tRPC ports
 * within the `max-lines` (800) and `max-lines-per-function` (250) limits of
 * oxlint.config.ts (issue #491). The tests run on a Bun without `bun lint`, so
 * the count is done here the way those rules do it with `skipBlankLines` and
 * `skipComments`: blank lines and comment-only lines do not count.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '../../..');
const MAX_FILE_LINES = 800;
const MAX_FUNCTION_LINES = 250;

/** Lines holding code: not blank, not only a comment. */
function codeLines(lines: string[]): number {
  let count = 0;
  let inBlockComment = false;
  for (const raw of lines) {
    let line = raw.trim();
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      inBlockComment = false;
      line = line.slice(end + 2).trim();
    }
    while (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end === -1) {
        inBlockComment = true;
        line = '';
        break;
      }
      line = line.slice(end + 2).trim();
    }
    if (line === '' || line.startsWith('//')) continue;
    count++;
  }
  return count;
}

const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

/** A top-level function: from its declaration to its closing `}` (the code is formatted). */
function functionLines(path: string, name: string): number {
  const lines = read(path).split('\n');
  const declaration = new RegExp(`^(export )?(async )?function ${name}\\b`);
  const start = lines.findIndex((line) => declaration.test(line));
  expect(start, `${name} is declared in ${path}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, i) => i > start && line === '}');
  return codeLines(lines.slice(start, end + 1));
}

const tsFilesIn = (dir: string) =>
  readdirSync(join(SRC, dir))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `${dir}/${file}`);

const FILES = [
  ...tsFilesIn('services/factory'),
  'services/thread-sandboxes/thread-sandbox-service.ts',
  ...tsFilesIn('trpc/ports'),
];

const FUNCTIONS: Array<[path: string, name: string]> = [
  ['services/factory/factory-action-provider.ts', 'createFactoryActionProvider'],
  ['services/factory/factory-batch-leader.ts', 'createBatchLeader'],
  ['services/factory/factory-flow-runs.ts', 'createFactoryFlowRuns'],
  ['services/factory/factory-pull-requests.ts', 'createFactoryPullRequests'],
  ['services/factory/factory-queue.ts', 'createFactoryQueue'],
  ['services/factory/factory-runs.ts', 'createFactoryRunsRepository'],
  ['services/factory/factory-sentinel.ts', 'createFactorySentinel'],
  ['services/thread-sandboxes/thread-sandbox-service.ts', 'createThreadSandboxService'],
  ['trpc/ports/factory.ts', 'createFactoryPort'],
];

describe('factory module size (max-lines, max-lines-per-function)', () => {
  test.each(FILES)(`%s has at most ${MAX_FILE_LINES} lines of code`, (path) => {
    expect(codeLines(read(path).split('\n'))).toBeLessThanOrEqual(MAX_FILE_LINES);
  });

  test.each(FUNCTIONS)(`%s: %s has at most ${MAX_FUNCTION_LINES} lines`, (path, name) => {
    expect(functionLines(path, name)).toBeLessThanOrEqual(MAX_FUNCTION_LINES);
  });

  test('counts code lines the way oxlint does (blank and comment lines skipped)', () => {
    const source = [
      '/**',
      ' * doc',
      ' */',
      '',
      'const a = 1; // trailing',
      '// only',
      'f(); /* x */',
    ];
    expect(codeLines(source)).toBe(2);
  });
});
