// Regression test for #480 (part 3/5 of #461): `anti-slop/no-known-value-widening`
// reports nothing in packages/server/src. An open `Record<string, X>` or an
// inline object type on a known value is replaced by a named contract (an
// interface, which the rule accepts) or by inference.
//
// It runs the repository's linter (`bun lint`, through scripts/bun-lint.ts),
// which only exists from Bun 1.4.6; on an older Bun (the CI test shards) it
// is skipped, and the CI lint job, on canary, still runs the linter itself.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// packages/server/src/__tests__ → the repository root.
const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const HAS_BUN_LINT = Bun.semver.order(Bun.version, '1.4.6') >= 0;
const RULE = 'anti-slop(no-known-value-widening)';

describe('anti-slop/no-known-value-widening in packages/server/src', () => {
  test.skipIf(!HAS_BUN_LINT)(
    'reports no warning',
    () => {
      const run = Bun.spawnSync(
        [process.execPath, 'scripts/bun-lint.ts', '--format', 'agent', 'packages/server/src'],
        { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
      );
      const output = `${run.stdout.toString()}\n${run.stderr.toString()}`;
      // Warnings do not fail the linter; a non-zero exit means it did not run.
      expect(run.exitCode).toBe(0);
      const warnings = output
        .split('\n')
        .filter((line) => line.includes(RULE))
        .map((line) => line.split(': warning')[0]);
      expect(warnings).toEqual([]);
    },
    300_000,
  );
});
