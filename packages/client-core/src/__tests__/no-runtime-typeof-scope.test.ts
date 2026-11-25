// Regression test for #458: `anti-slop/no-runtime-typeof` reports nothing in
// the client packages (client, client-gpuix, client-core, client-benchmark,
// chrome-extension, gpuix-ui). A `typeof` there belongs in a `value is T`
// guard, which the rule allows (`allowInTypeGuards: true`).
//
// It runs the repository's linter (`bun lint`, through scripts/bun-lint.ts),
// which only exists from Bun 1.4.6; on an older Bun (the CI test shards) it
// is skipped, and the CI lint job, on canary, still runs the linter itself.
// It lives in client-core, whose suite runs on bun test with Bun's types.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// packages/client-core/src/__tests__ → the repository root.
const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const HAS_BUN_LINT = Bun.semver.order(Bun.version, '1.4.6') >= 0;
const SCOPE = [
  'packages/client',
  'packages/client-gpuix',
  'packages/client-core',
  'packages/client-benchmark',
  'packages/chrome-extension',
  'packages/gpuix-ui',
];

describe('anti-slop/no-runtime-typeof in the client packages', () => {
  test.skipIf(!HAS_BUN_LINT)(
    'reports no warning',
    () => {
      const run = Bun.spawnSync(
        [process.execPath, 'scripts/bun-lint.ts', '--format', 'agent', ...SCOPE],
        { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
      );
      // A linter that did not start (bad config, missing plugin) prints no warnings either.
      expect(run.exitCode).toBe(0);
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
