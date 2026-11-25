import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Issue #490: the client stores and hooks stay under the repository's length
 * rules (`max-lines` 800, `max-lines-per-function` 250, both skipping blank
 * and comment lines; oxlint.config.ts). Those rules only warn, so `bun run
 * lint` passes with them; this test fails instead.
 *
 * Where Bun has the built-in linter (1.4.6 canary and later) the test runs the
 * repository's linter itself and expects no length warning in `src/stores` and
 * `src/hooks`. Older Bun (the pinned CI test jobs) has no `bun lint`, so a line
 * count of the files that used to break the file limit always runs.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const clientSrc = join(repoRoot, 'packages/client/src');

const MAX_FILE_LINES = 800;
const LENGTH_RULE = /eslint\(max-lines(-per-function)?\)/;

/** True from Bun 1.4.6 (the first canary with `bun lint`). */
function hasBunLint(): boolean {
  const [major = 0, minor = 0, patch = 0] = (process.versions.bun ?? '0.0.0')
    .split(/[.-]/)
    .map(Number);
  return major * 1e6 + minor * 1e3 + patch >= 1_004_006;
}

/** Lines `max-lines` counts with skipBlankLines and skipComments: lines that
 *  hold something besides whitespace and comments. */
function countedLines(source: string): number {
  let inBlockComment = false;
  let count = 0;
  for (const raw of source.split('\n')) {
    let line = raw;
    let code = '';
    while (line.length > 0) {
      if (inBlockComment) {
        const end = line.indexOf('*/');
        if (end < 0) break;
        line = line.slice(end + 2);
        inBlockComment = false;
        continue;
      }
      const block = line.indexOf('/*');
      const lineComment = line.indexOf('//');
      if (lineComment >= 0 && (block < 0 || lineComment < block)) {
        code += line.slice(0, lineComment);
        break;
      }
      if (block < 0) {
        code += line;
        break;
      }
      code += line.slice(0, block);
      line = line.slice(block + 2);
      inBlockComment = true;
    }
    if (code.trim().length > 0) count++;
  }
  return count;
}

describe('client stores and hooks length (#490)', () => {
  test.each([
    'stores/thread-store.ts',
    'stores/ui-store.ts',
    'stores/test-store.ts',
    'stores/browser-panel-store.ts',
    'hooks/ws-event-dispatch.ts',
    'hooks/use-review-state.ts',
    'hooks/use-review-actions.ts',
    'hooks/use-diff-data.ts',
  ])('%s stays under the max-lines limit', (file) => {
    const source = readFileSync(join(clientSrc, file), 'utf8');
    expect(countedLines(source)).toBeLessThanOrEqual(MAX_FILE_LINES);
  });

  test.skipIf(!hasBunLint())(
    'the linter reports no max-lines or max-lines-per-function warning',
    () => {
      const run = spawnSync(
        process.execPath,
        [
          join(repoRoot, 'scripts/bun-lint.ts'),
          '--format',
          'agent',
          'packages/client/src/stores',
          'packages/client/src/hooks',
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      const output = `${run.stdout}\n${run.stderr}`;
      // The linter ran (it has no errors here; warnings do not change the code).
      expect(run.status).toBe(0);
      const lengthWarnings = output.split('\n').filter((line) => LENGTH_RULE.test(line));
      expect(lengthWarnings).toEqual([]);
    },
    120_000,
  );
});
