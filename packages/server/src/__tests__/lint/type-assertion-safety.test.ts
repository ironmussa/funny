/**
 * Regression test for #450: every `as T` type assertion in the server's
 * production code either goes away or states its invariant in a `// SAFETY:`
 * comment (anti-slop/require-safety-comment-for-type-assertion).
 *
 * The rule is only a warning, so `bun run lint` does not fail when a new bare
 * assertion lands; this test does. It runs the repository's own linter
 * (`scripts/bun-lint.ts`, the root oxlint.config.ts) on `packages/server/src`,
 * plus a probe file with one bare assertion that must be reported, so a linter
 * that stopped running or lost the rule cannot make the test pass.
 *
 * `bun lint` exists only from Bun 1.4.6 (canary, the version the pre-commit
 * hook and the CI lint job use); on an older Bun the test is skipped.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const RULE = 'require-safety-comment-for-type-assertion';
/** Same minimum as scripts/bun-lint.ts. */
const MIN_BUN_WITH_LINT = '1.4.6';
const hasBunLint = Bun.semver.order(Bun.version, MIN_BUN_WITH_LINT) >= 0;

const repoRoot = resolve(import.meta.dir, '../../../../..');
const serverRoot = join(repoRoot, 'packages/server');

function ruleWarnings(output: string): string[] {
  return output.split('\n').filter((line) => line.includes(`(${RULE})`));
}

describe('server type assertions (#450)', () => {
  test.skipIf(!hasBunLint)(
    'every type assertion in packages/server/src has a SAFETY comment',
    () => {
      // Outside src/ and __tests__/ (where the rule is off), inside the lint config's scope.
      const probeDir = mkdtempSync(join(serverRoot, 'lint-probe-'));
      const probe = join(probeDir, 'probe.ts');
      writeFileSync(probe, 'export const probe = JSON.parse("1") as number;\n');
      try {
        const run = Bun.spawnSync(
          [
            process.execPath,
            'scripts/bun-lint.ts',
            '--format',
            'agent',
            'packages/server/src',
            relative(repoRoot, probe),
          ],
          { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
        );
        const warnings = ruleWarnings(run.stdout.toString());
        const probeName = relative(repoRoot, probe);

        // The linter ran with the rule on: the bare assertion in the probe is reported.
        expect(warnings.filter((line) => line.startsWith(probeName))).toHaveLength(1);
        // And nothing in the server's production code is.
        expect(warnings.filter((line) => !line.startsWith(probeName))).toEqual([]);
      } finally {
        rmSync(probeDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
