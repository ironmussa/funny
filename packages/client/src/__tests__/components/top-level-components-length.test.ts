/**
 * Issue #488: the components directly under `packages/client/src/components/`
 * stay under the length limits of oxlint.config.ts (`max-lines-per-function`
 * 250, `max-lines` 800). The rules only warn, so `bun run lint` would not catch
 * a component growing back over them; this test does.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const componentsDir = 'packages/client/src/components';

function topLevelComponentFiles(): string[] {
  return readdirSync(resolve(repoRoot, componentsDir))
    .filter((file) => file.endsWith('.tsx') && !file.endsWith('.stories.tsx'))
    .map((file) => `${componentsDir}/${file}`)
    .sort();
}

describe('top-level client components', () => {
  test('report no max-lines or max-lines-per-function warnings', () => {
    const files = topLevelComponentFiles();
    expect(files.length).toBeGreaterThan(0);

    // The same invocation as scripts/bun-lint.ts, in its one-line-per-problem format.
    const run = spawnSync(
      process.execPath,
      ['lint', '--no-script', '--disable-nested-config', '--format', 'agent', ...files],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const output = `${run.stdout}\n${run.stderr}`;

    const lengthWarnings = output
      .split('\n')
      .filter((line) => /eslint\(max-lines(-per-function)?\)/.test(line))
      .map((line) => line.replace(/ help:.*$/, ''));

    expect(lengthWarnings).toEqual([]);
    // Guard against a linter that did not run at all (and so reported nothing).
    expect(output).not.toContain('needs Bun');
    expect(run.status).toBe(0);
  }, 120_000);
});
