// Regression test for #460: `anti-slop/no-runtime-typeof` reports nothing
// outside the client packages, packages/server and packages/runtime (those
// are covered by the other sub-issues of #447). A `typeof` there belongs in a
// `value is T` guard, which the rule allows (`allowInTypeGuards: true`).
//
// It runs the repository's linter (`bun lint`, through scripts/bun-lint.ts),
// which only exists from Bun 1.4.6; on an older Bun (the CI test shards) it
// is skipped, and the CI lint job, on canary, still runs the linter itself.
// It lives in core, where most of the fixes are, so the core suite runs it.
import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// packages/core/src/__tests__ → the repository root.
const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const HAS_BUN_LINT = Bun.semver.order(Bun.version, '1.4.6') >= 0;
const OUT_OF_SCOPE = /^(client.*|server|runtime)$/;

/** The paths #460 covers: every package but the out-of-scope ones, plus the top-level dirs. */
function scopePaths(): string[] {
  const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !OUT_OF_SCOPE.test(entry.name))
    .map((entry) => `packages/${entry.name}`);
  return [...packages, 'scripts', 'spikes', 'e2e'];
}

describe('anti-slop/no-runtime-typeof outside client, server and runtime', () => {
  test.skipIf(!HAS_BUN_LINT)(
    'reports no warning',
    () => {
      const run = Bun.spawnSync(
        [process.execPath, 'scripts/bun-lint.ts', '--format', 'agent', ...scopePaths()],
        { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
      );
      const output = `${run.stdout.toString()}\n${run.stderr.toString()}`;
      const warnings = output
        .split('\n')
        .filter((line) => line.includes('no-runtime-typeof'))
        .map((line) => line.split(': warning')[0]);
      expect(warnings).toEqual([]);
    },
    300_000,
  );
});
